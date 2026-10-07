import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { tl } from "@mtcute/node";
import { rejected } from "../testing/thrown.ts";
import { VerbatimError } from "../command/mod.ts";
import { clientRefusal } from "./client_refusal.ts";
import type { PeerRef } from "./client.ts";
import type { RawChat } from "./chat.ts";
import type { RawMessage } from "./message.ts";
import { parsePeer } from "./peer.ts";
import { findMessages, SCAN_CAP, SCAN_CAP_WARNING } from "./search.ts";
import type { SearchClient, SearchInChat } from "./search.ts";
import type { SearchPlan } from "./search_plan.ts";
import { noFile } from "./message_file.ts";

const IVAN: RawChat = {
  peerType: "user",
  rawId: 500001,
  title: "Иван Петров",
  username: "ivan",
};

const CHAT: RawChat = {
  peerType: "supergroup",
  rawId: 101,
  title: "Команда выгрузок",
  username: "team_uploads",
};

/** Сообщение чата `CHAT` от заданного отправителя. */
function message(id: number, sender: RawChat | null): RawMessage {
  return {
    id,
    chat: CHAT,
    sender,
    date: new Date("2026-08-16T07:54:28.000Z"),
    text: `сообщение ${id}`,
    file: noFile(0),
    entities: [],
  };
}

function plan(over: Partial<SearchPlan> = {}): SearchPlan {
  return { query: "выгрузка", chat: null, from: null, limit: 50, ...over };
}

function target(raw: string) {
  return { target: raw, peer: parsePeer(raw) };
}

/** Клиент, у которого поиск не зовётся: тест сам объявляет, что зовётся. */
function client(over: Partial<SearchClient> = {}): SearchClient {
  return {
    resolve: (peer) =>
      Promise.resolve({ ref: peer, id: peer.kind === "id" ? peer.id : 1 }),
    searchChats: () => Promise.resolve([]),
    searchInChat: () => Promise.reject(new Error("поиск в чате не ожидался")),
    // deno-lint-ignore require-yield
    searchGlobal: async function* () {
      throw new Error("глобальный поиск не ожидался");
    },
    ...over,
  };
}

/**
 * Отказ резолва имени в том виде, в каком его отдаёт порт сеанса: двойник
 * стоит выше классификатора (`session.ts`).
 */
function notOccupied(): unknown {
  return clientRefusal(new tl.RpcError(400, "USERNAME_NOT_OCCUPIED"));
}

describe("дефект клиента в поиске — тот же объект, не отказ Telegram", () => {
  it("глобальный поиск", async () => {
    const defect = new TypeError("дефект глобального поиска");
    const err = await rejected(
      () =>
        findMessages(
          client({
            // deno-lint-ignore require-yield
            searchGlobal: async function* () {
              throw defect;
            },
          }),
          plan(),
        ),
      Error,
    );
    expect(err).toBe(defect);
  });
  it("скан глобального поиска с --from", async () => {
    const defect = new TypeError("дефект скана");
    const err = await rejected(
      () =>
        findMessages(
          client({
            // deno-lint-ignore require-yield
            searchGlobal: async function* () {
              throw defect;
            },
          }),
          plan({ from: target("500001") }),
        ),
      Error,
    );
    expect(err).toBe(defect);
  });
  it("поиск в чате", async () => {
    const defect = new TypeError("дефект поиска в чате");
    const err = await rejected(
      () =>
        findMessages(
          client({ searchInChat: () => Promise.reject(defect) }),
          plan({ chat: target("-1000000000101") }),
        ),
      Error,
    );
    expect(err).toBe(defect);
  });
});

it("поиск внутри чата: адресаты уходят на сервер", async () => {
  const seen: SearchInChat[] = [];
  const found = await findMessages(
    client({
      searchInChat: (params) => {
        seen.push(params);
        return Promise.resolve([message(4821, IVAN)]);
      },
    }),
    plan({ chat: target("-1000000000101"), from: target("@ivan"), limit: 20 }),
  );
  expect(seen.length).toStrictEqual(1);
  expect(seen[0].query).toStrictEqual("выгрузка");
  expect(seen[0].limit).toStrictEqual(20);
  expect(seen[0].chat.id).toStrictEqual(-1000000000101);
  expect(seen[0].from?.ref).toStrictEqual({ kind: "name", name: "ivan" });
  expect(found.messages.map((message) => message.id)).toStrictEqual([4821]);
  expect(found.scanCapped).toStrictEqual(false);
});

it("история чата: пустой запрос уходит как есть", async () => {
  const seen: SearchInChat[] = [];
  await findMessages(
    client({
      searchInChat: (params) => {
        seen.push(params);
        return Promise.resolve([]);
      },
    }),
    plan({ query: "", chat: target("me") }),
  );
  expect(seen[0].query).toStrictEqual("");
  expect(seen[0].from).toStrictEqual(null);
});

it("глобальный поиск без --from: берётся не больше --limit", async () => {
  let taken = 0;
  const found = await findMessages(
    client({
      searchGlobal: async function* () {
        for (let id = 1; id <= 100; id += 1) {
          taken += 1;
          yield await Promise.resolve(message(id, IVAN));
        }
      },
    }),
    plan({ limit: 3 }),
  );
  expect(found.messages.map((message) => message.id)).toStrictEqual([1, 2, 3]);
  expect(found.scanCapped).toStrictEqual(false);
  // Выдача просматривается лениво: лишние страницы не вычерпываются.
  expect(taken).toStrictEqual(3);
});

it("глобальный поиск с --from: фильтр на стороне команды", async () => {
  const found = await findMessages(
    client({
      searchGlobal: async function* () {
        yield await Promise.resolve(message(1, IVAN));
        yield await Promise.resolve(message(2, CHAT));
        yield await Promise.resolve(message(3, null));
        yield await Promise.resolve(message(4, IVAN));
      },
    }),
    plan({ from: target("500001") }),
  );
  expect(found.messages.map((message) => message.id)).toStrictEqual([1, 4]);
  expect(found.scanCapped).toStrictEqual(false);
});

describe("потолок скана: предупреждение только при недоборе", () => {
  const search = (matchEvery: number) =>
    async function* () {
      for (let id = 1; id <= SCAN_CAP + 10; id += 1) {
        yield await Promise.resolve(
          message(id, id % matchEvery === 0 ? IVAN : CHAT),
        );
      }
    };
  it("совпадений меньше --limit — скан остановлен", async () => {
    const found = await findMessages(
      client({ searchGlobal: search(500) }),
      plan({ from: target("500001"), limit: 50 }),
    );
    expect(found.messages.length).toStrictEqual(2);
    expect(found.scanCapped).toStrictEqual(true);
  });
  it("совпадений набралось — потолка не было", async () => {
    const found = await findMessages(
      client({ searchGlobal: search(2) }),
      plan({ from: target("500001"), limit: 50 }),
    );
    expect(found.messages.length).toStrictEqual(50);
    expect(found.scanCapped).toStrictEqual(false);
  });
  it("выдача иссякла раньше потолка — молчание", async () => {
    const found = await findMessages(
      client({
        searchGlobal: async function* () {
          yield await Promise.resolve(message(1, IVAN));
        },
      }),
      plan({ from: target("500001"), limit: 50 }),
    );
    expect(found.messages.length).toStrictEqual(1);
    expect(found.scanCapped).toStrictEqual(false);
  });
});

it("строка предупреждения совпадает с голденом", async () => {
  expect(`${SCAN_CAP_WARNING}\n`).toStrictEqual(
    await readFile(
      new URL(
        "./testdata/telegram-search/warn-scan-cap-stderr.txt",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

describe("отказ резолва называет свой предмет", () => {
  const failing = client({
    resolve: () => Promise.reject(notOccupied()),
    searchChats: () => Promise.resolve([]),
  });
  it("--chat — чат", async () => {
    const err = await rejected(
      () => findMessages(failing, plan({ chat: target("Команда") })),
      VerbatimError,
    );
    expect(err.message.startsWith("telegram: не удалось найти чат"))
      .toStrictEqual(true);
  });
  it("--from — отправителя", async () => {
    const err = await rejected(
      () =>
        findMessages(
          client({
            ...failing,
            searchInChat: () => Promise.resolve([]),
            resolve: (peer) =>
              peer.kind === "id"
                ? Promise.resolve<PeerRef>({ ref: peer, id: peer.id })
                : Promise.reject(notOccupied()),
          }),
          plan({ chat: target("-1000000000101"), from: target("Иван") }),
        ),
      VerbatimError,
    );
    expect(err.message).toStrictEqual(
      "telegram: не удалось найти отправителя 'Иван': совпадений нет; " +
        "попробуй: mpu telegram ls 'Иван' и укажи id или @username",
    );
  });
});
