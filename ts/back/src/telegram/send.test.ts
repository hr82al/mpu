import { describe, expect, it } from "vitest";
import { MtPeerNotFoundError, tl } from "@mtcute/node";
import { VerbatimError } from "../command/mod.ts";
import { clientRefusal } from "./client_refusal.ts";
import { configError } from "./errors.ts";
import type { Peer } from "./peer.ts";
import type { ClientMessage, PeerRef, TelegramClient } from "./client.ts";
import type { RawChat } from "./chat.ts";
import { sendMessage, type SendPlan } from "./send.ts";
import { rejected } from "../testing/thrown.ts";

/**
 * Отказ клиента в том виде, в каком его отдаёт порт сеанса: двойник порта
 * стоит выше классификатора (`session.ts`), и сочинять за порт форму
 * отказа тесту не за что.
 */
function refused(original: Error): Error {
  const err = clientRefusal(original);
  if (!(err instanceof Error)) throw new TypeError("отказ клиента не оформлен");
  return err;
}

/** Что фейковый клиент увидел и в каком порядке. */
interface Seen {
  readonly calls: string[];
  readonly texts: string[];
  readonly captions: (string | undefined)[][];
  readonly markdown: boolean[];
  readonly documents: string[][];
}

function stand(
  outcome: readonly ClientMessage[],
  fail?: {
    /** Что именно отказывает: имя, найденный поиском id или отправка. */
    readonly on: "resolve:name" | "resolve:id" | "send";
    readonly err: Error;
  },
  found: readonly RawChat[] = [],
): { readonly client: TelegramClient; readonly seen: Seen } {
  const seen: Seen = {
    calls: [],
    texts: [],
    captions: [],
    markdown: [],
    documents: [],
  };
  const ref: PeerRef = { ref: "peer", id: 100000001 };
  const client: TelegramClient = {
    resolve: (peer: Peer) => {
      seen.calls.push(`resolve:${peer.kind}`);
      const stage = peer.kind === "id" ? "resolve:id" : "resolve:name";
      if (fail?.on === stage) return Promise.reject(fail.err);
      return Promise.resolve(ref);
    },
    sendText: (_to, text, markdown) => {
      seen.calls.push("sendText");
      seen.texts.push(text);
      seen.markdown.push(markdown);
      if (fail?.on === "send") return Promise.reject(fail.err);
      return Promise.resolve(outcome[0]);
    },
    sendDocuments: (_to, docs, markdown) => {
      seen.calls.push("sendDocuments");
      seen.captions.push(docs.map((doc) => doc.caption));
      seen.markdown.push(markdown);
      seen.documents.push(docs.map((doc) => doc.name));
      if (fail?.on === "send") return Promise.reject(fail.err);
      return Promise.resolve(outcome);
    },
    listDialogs: () => {
      seen.calls.push("listDialogs");
      return Promise.resolve(found);
    },
    searchChats: (query) => {
      seen.calls.push(`searchChats:${query}`);
      return Promise.resolve(found);
    },
  };
  return { client, seen };
}

function plan(patch: Partial<SendPlan> = {}): SendPlan {
  return {
    target: "me",
    peer: { kind: "me" },
    text: "привет",
    markdown: false,
    attachments: [],
    ...patch,
  };
}

const AT = new Date(Date.UTC(2026, 7, 16, 8, 4, 9));

function message(
  id: number,
  patch: Partial<ClientMessage> = {},
): ClientMessage {
  return { id, chatId: 100000001, date: AT, ...patch };
}

it("текст уходит одним сообщением", async () => {
  const { client, seen } = stand([message(5000001)]);
  expect(await sendMessage(client, plan())).toStrictEqual({
    id: 5000001,
    chatId: 100000001,
    date: "2026-08-16T08:04:09+00:00",
  });
  expect(seen.texts).toStrictEqual(["привет"]);
  expect(seen.documents).toStrictEqual([]);
});

it("адресат резолвится один раз и до отправки", async () => {
  const { client, seen } = stand([message(5000001)]);
  await sendMessage(
    client,
    plan({ target: "@durov", peer: { kind: "name", name: "durov" } }),
  );
  expect(seen.calls).toStrictEqual(["resolve:name", "sendText"]);
});

it("вложения уходят одним альбомом, подпись — у последнего", async () => {
  const { client, seen } = stand([message(5000003), message(5000004)]);
  const sent = await sendMessage(
    client,
    plan({
      text: "подпись",
      attachments: [
        { name: "a.txt", bytes: new Uint8Array([1]) },
        { name: "b.txt", bytes: new Uint8Array([2]) },
      ],
    }),
  );
  expect(sent.id).toStrictEqual(5000004);
  expect(seen.calls).toStrictEqual(["resolve:me", "sendDocuments"]);
  expect(seen.documents).toStrictEqual([["a.txt", "b.txt"]]);
  // Подпись несёт последнее вложение, у прочих её нет вовсе.
  expect(seen.captions).toStrictEqual([[undefined, "подпись"]]);
  expect(seen.texts).toStrictEqual([]);
});

it("пустой текст — вложение без подписи", async () => {
  const { client, seen } = stand([message(5000002)]);
  await sendMessage(
    client,
    plan({
      text: "",
      attachments: [{ name: "a.txt", bytes: new Uint8Array([1]) }],
    }),
  );
  expect(seen.captions).toStrictEqual([[undefined]]);
});

describe("--md действует и на текст, и на подпись", () => {
  it("текст", async () => {
    const { client, seen } = stand([message(5000001)]);
    await sendMessage(client, plan({ markdown: true }));
    expect(seen.markdown).toStrictEqual([true]);
  });
  it("подпись", async () => {
    const { client, seen } = stand([message(5000002)]);
    await sendMessage(
      client,
      plan({
        markdown: true,
        attachments: [{ name: "a.txt", bytes: new Uint8Array([1]) }],
      }),
    );
    expect(seen.markdown).toStrictEqual([true]);
  });
});

it("времени Telegram не сообщил — date остаётся null", async () => {
  const { client } = stand([message(5000001, { date: null })]);
  expect((await sendMessage(client, plan())).date).toStrictEqual(null);
});

it("идентификатора чата нет — отказ операции, а не ноль", async () => {
  const { client } = stand([message(5000001, { chatId: null })]);
  const err = await rejected(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  expect(err.message).toStrictEqual(
    "telegram: Telegram не сообщил идентификатор чата",
  );
});

it("адресат-название ищется поиском, а не резолвится напрямую", async () => {
  const { client, seen } = stand([message(5000001)], undefined, [
    { peerType: "supergroup", rawId: 3, title: "Команда", username: null },
  ]);
  await sendMessage(
    client,
    plan({ target: "Команда", peer: { kind: "title", title: "Команда" } }),
  );
  expect(seen.calls).toStrictEqual([
    "searchChats:Команда",
    "resolve:id",
    "sendText",
  ]);
});

it("имени такого нет — вторая попытка ищет чат по названию", async () => {
  // Латинская строка без пробелов («news», «DEV») — обычное название
  // чата, и до поиска она обязана дойти.
  const { client, seen } = stand([message(5000001)], {
    on: "resolve:name",
    err: refused(new MtPeerNotFoundError("Peer with username news not found")),
  }, [
    { peerType: "supergroup", rawId: 3, title: "news", username: null },
  ]);
  const sent = await sendMessage(
    client,
    plan({ target: "news", peer: { kind: "guess", name: "news" } }),
  );
  expect(sent.id).toStrictEqual(5000001);
  expect(seen.calls).toStrictEqual([
    "resolve:name",
    "searchChats:news",
    "resolve:id",
    "sendText",
  ]);
});

it("несколько чатов с таким названием — отказ со списком", async () => {
  const { client, seen } = stand([message(5000001)], {
    on: "resolve:name",
    err: refused(new MtPeerNotFoundError("Peer with username news not found")),
  }, [
    { peerType: "supergroup", rawId: 3, title: "news рынка", username: null },
    { peerType: "channel", rawId: 4, title: "news дня", username: null },
  ]);
  const err = await rejected(
    () =>
      sendMessage(
        client,
        plan({ target: "news", peer: { kind: "guess", name: "news" } }),
      ),
    VerbatimError,
  );
  expect(err.message).toStrictEqual(
    "telegram: под название 'news' подходит несколько чатов: " +
      "'news рынка' → id -1000000000003; 'news дня' → id -1000000000004; " +
      "попробуй: указать адресата по id или @username",
  );
  expect(seen.calls).toStrictEqual(["resolve:name", "searchChats:news"]);
});

it("объявленное имя второй попытки не получает", async () => {
  const { client, seen } = stand([message(5000001)], {
    on: "resolve:name",
    err: refused(new MtPeerNotFoundError("Peer with username durov not found")),
  }, [
    { peerType: "supergroup", rawId: 3, title: "durov", username: null },
  ]);
  const err = await rejected(
    () =>
      sendMessage(
        client,
        plan({ target: "@durov", peer: { kind: "name", name: "durov" } }),
      ),
    VerbatimError,
  );
  // Пользователь сам сказал, что это имя, — искать чат с таким названием
  // не за чем.
  expect(seen.calls).toStrictEqual(["resolve:name"]);
  expect(
    err.message.startsWith("telegram: не удалось найти чат '@durov'"),
  ).toStrictEqual(true);
});

it("своё оформление отказа резолва без причины — само себе причина", async () => {
  // Порт отдаёт строку слоя без исходного отказа клиента, когда отказ
  // оформил сам сеанс (адресат без идентификатора): причиной «не удалось
  // найти» становится она сама, а не пустота.
  const own = configError(
    "Telegram вернул адресата без идентификатора: inputPeerEmpty",
  );
  const { client } = stand([message(5000001)], {
    on: "resolve:name",
    err: own,
  });
  const err = await rejected(
    () =>
      sendMessage(
        client,
        plan({ target: "@durov", peer: { kind: "name", name: "durov" } }),
      ),
    VerbatimError,
  );
  expect(err.cause).toBe(own);
  expect(
    err.message.includes("Telegram вернул адресата без идентификатора"),
    err.message,
  ).toStrictEqual(true);
});

it("название без совпадений — отказ поиска, а не отправка", async () => {
  const { client, seen } = stand([message(5000001)], undefined, []);
  const err = await rejected(
    () =>
      sendMessage(
        client,
        plan({ target: "Команда", peer: { kind: "title", title: "Команда" } }),
      ),
    VerbatimError,
  );
  expect(err.message).toStrictEqual(
    "telegram: не удалось найти чат 'Команда': совпадений нет; " +
      "попробуй: mpu telegram ls 'Команда' и укажи id или @username",
  );
  expect(seen.calls).toStrictEqual(["searchChats:Команда"]);
});

it("ни имени, ни чата с таким названием — отказ поиска", async () => {
  // То, что увидит пользователь живьём: первая попытка отказала,
  // вторая ничего не нашла.
  const { client, seen } = stand([], {
    on: "resolve:name",
    err: refused(new MtPeerNotFoundError("Peer with username news not found")),
  }, []);
  const err = await rejected(
    () =>
      sendMessage(
        client,
        plan({ target: "news", peer: { kind: "guess", name: "news" } }),
      ),
    VerbatimError,
  );
  expect(err.message).toStrictEqual(
    "telegram: не удалось найти чат 'news': совпадений нет; " +
      "попробуй: mpu telegram ls 'news' и укажи id или @username",
  );
  expect(seen.calls).toStrictEqual(["resolve:name", "searchChats:news"]);
  // Отказ первой попытки не показывается, но и не теряется.
  expect((err.cause as Error).message).toStrictEqual(
    "Peer with username news not found",
  );
});

it("имя нашлось — второй попытки не делается", async () => {
  const { client, seen } = stand([message(5000001)], undefined, [
    { peerType: "supergroup", rawId: 3, title: "durov", username: null },
  ]);
  await sendMessage(
    client,
    plan({ target: "durov", peer: { kind: "guess", name: "durov" } }),
  );
  expect(seen.calls).toStrictEqual(["resolve:name", "sendText"]);
});

it("отказ на найденном чате — отказ Telegram, не «не найден»", async () => {
  const flood = refused(
    tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_42" }),
  );
  const { client, seen } = stand([message(5000001)], {
    on: "resolve:id",
    err: flood,
  }, [{ peerType: "supergroup", rawId: 3, title: "news", username: null }]);
  const err = await rejected(
    () =>
      sendMessage(
        client,
        plan({ target: "news", peer: { kind: "title", title: "news" } }),
      ),
    VerbatimError,
  );
  // Чат только что нашёлся, его id пришёл от сервера — значит это отказ
  // операции, а не ненайденный адресат.
  expect(err.message).toStrictEqual("telegram: rate-limit, подожди 42s");
  expect(seen.calls).toStrictEqual(["searchChats:news", "resolve:id"]);
});

it("отказ отправки не выдаётся за отказ адресата", async () => {
  const { client } = stand([], {
    on: "send",
    err: refused(new tl.RpcError(400, "MEDIA_EMPTY")),
  });
  const err = await rejected(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  expect(err.message).toStrictEqual("telegram: RPC error: MEDIA_EMPTY");
});

describe("дефект клиента не выдаётся ни за отказ Telegram, ни за «не найден»", () => {
  // Спека, «Что считается отказом Telegram / слоя клиента»: отказ клиента
  // оформляет порт сеанса; не оформленное портом — не отказ Telegram и
  // уходит тем же объектом (код 1 и исходный текст ставит точка входа).
  const cases: readonly {
    readonly name: string;
    readonly on: "send" | "resolve:id" | "resolve:name";
    readonly target: string;
    readonly peer: Peer;
    readonly found: readonly RawChat[];
  }[] = [
    {
      name: "отправка",
      on: "send",
      target: "me",
      peer: { kind: "me" },
      found: [],
    },
    {
      name: "резолв найденного по названию чата",
      on: "resolve:id",
      target: "news",
      peer: { kind: "title", title: "news" },
      found: [
        { peerType: "supergroup", rawId: 3, title: "news", username: null },
      ],
    },
    {
      name: "штатный резолв строки-догадки",
      on: "resolve:name",
      target: "news",
      peer: { kind: "guess", name: "news" },
      found: [],
    },
  ];
  for (const { name, on, target, peer, found } of cases) {
    it(name, async () => {
      const defect = new TypeError(`дефект: ${name}`);
      const { client } = stand(
        [message(5000001)],
        { on, err: defect },
        found,
      );
      const err = await rejected(
        () => sendMessage(client, plan({ target, peer })),
        Error,
      );
      expect(err).toBe(defect);
    });
  }
});

it("отказ двойника без Error уходит как есть", async () => {
  // Не-Error бросают редко: молча потерять такой отказ нельзя, а выдавать
  // его за отказ Telegram — тоже.
  const { client } = stand([], {
    on: "send",
    err: "странный отказ" as unknown as Error,
  });
  const outcome = await sendMessage(client, plan()).then(
    () => "ушло",
    (err: unknown) => err,
  );
  expect(outcome).toStrictEqual("странный отказ");
});

it("rate-limit сообщается со сроком ожидания", async () => {
  const flood = refused(
    tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_42" }),
  );
  const { client } = stand([], { on: "send", err: flood });
  const err = await rejected(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  expect(err.message).toStrictEqual("telegram: rate-limit, подожди 42s");
});
