import { assertEquals, assertRejects } from "@std/assert";
import { VerbatimError } from "../command/mod.ts";
import type { PeerRef } from "./client.ts";
import type { RawChat } from "./chat.ts";
import type { RawMessage } from "./message.ts";
import { parsePeer } from "./peer.ts";
import { findMessages, SCAN_CAP, SCAN_CAP_WARNING } from "./search.ts";
import type { SearchClient, SearchInChat } from "./search.ts";
import type { SearchPlan } from "./search_plan.ts";

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

Deno.test("поиск внутри чата: адресаты уходят на сервер", async () => {
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
  assertEquals(seen.length, 1);
  assertEquals(seen[0].query, "выгрузка");
  assertEquals(seen[0].limit, 20);
  assertEquals(seen[0].chat.id, -1000000000101);
  assertEquals(seen[0].from?.ref, { kind: "name", name: "ivan" });
  assertEquals(found.messages.map((message) => message.id), [4821]);
  assertEquals(found.scanCapped, false);
});

Deno.test("история чата: пустой запрос уходит как есть", async () => {
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
  assertEquals(seen[0].query, "");
  assertEquals(seen[0].from, null);
});

Deno.test("глобальный поиск без --from: берётся не больше --limit", async () => {
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
  assertEquals(found.messages.map((message) => message.id), [1, 2, 3]);
  assertEquals(found.scanCapped, false);
  // Выдача просматривается лениво: лишние страницы не вычерпываются.
  assertEquals(taken, 3);
});

Deno.test("глобальный поиск с --from: фильтр на стороне команды", async () => {
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
  assertEquals(found.messages.map((message) => message.id), [1, 4]);
  assertEquals(found.scanCapped, false);
});

Deno.test("потолок скана: предупреждение только при недоборе", async (t) => {
  const search = (matchEvery: number) =>
    async function* () {
      for (let id = 1; id <= SCAN_CAP + 10; id += 1) {
        yield await Promise.resolve(
          message(id, id % matchEvery === 0 ? IVAN : CHAT),
        );
      }
    };
  await t.step("совпадений меньше --limit — скан остановлен", async () => {
    const found = await findMessages(
      client({ searchGlobal: search(500) }),
      plan({ from: target("500001"), limit: 50 }),
    );
    assertEquals(found.messages.length, 2);
    assertEquals(found.scanCapped, true);
  });
  await t.step("совпадений набралось — потолка не было", async () => {
    const found = await findMessages(
      client({ searchGlobal: search(2) }),
      plan({ from: target("500001"), limit: 50 }),
    );
    assertEquals(found.messages.length, 50);
    assertEquals(found.scanCapped, false);
  });
  await t.step("выдача иссякла раньше потолка — молчание", async () => {
    const found = await findMessages(
      client({
        searchGlobal: async function* () {
          yield await Promise.resolve(message(1, IVAN));
        },
      }),
      plan({ from: target("500001"), limit: 50 }),
    );
    assertEquals(found.messages.length, 1);
    assertEquals(found.scanCapped, false);
  });
});

Deno.test("строка предупреждения совпадает с голденом", async () => {
  assertEquals(
    `${SCAN_CAP_WARNING}\n`,
    await Deno.readTextFile(
      new URL(
        "./testdata/telegram-search/warn-scan-cap-stderr.txt",
        import.meta.url,
      ),
    ),
  );
});

Deno.test("отказ резолва называет свой предмет", async (t) => {
  const failing = client({
    resolve: () => Promise.reject(new Error("USERNAME_NOT_OCCUPIED")),
    searchChats: () => Promise.resolve([]),
  });
  await t.step("--chat — чат", async () => {
    const err = await assertRejects(
      () => findMessages(failing, plan({ chat: target("Команда") })),
      VerbatimError,
    );
    assertEquals(
      err.message.startsWith("telegram: не удалось найти чат"),
      true,
    );
  });
  await t.step("--from — отправителя", async () => {
    const err = await assertRejects(
      () =>
        findMessages(
          client({
            ...failing,
            searchInChat: () => Promise.resolve([]),
            resolve: (peer) =>
              peer.kind === "id"
                ? Promise.resolve<PeerRef>({ ref: peer, id: peer.id })
                : Promise.reject(new Error("USERNAME_NOT_OCCUPIED")),
          }),
          plan({ chat: target("-1000000000101"), from: target("Иван") }),
        ),
      VerbatimError,
    );
    assertEquals(
      err.message,
      "telegram: не удалось найти отправителя 'Иван': совпадений нет; " +
        "попробуй: mpu telegram ls 'Иван' и укажи id или @username",
    );
  });
});
