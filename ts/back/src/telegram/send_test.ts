import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { MtPeerNotFoundError, tl } from "@mtcute/deno";
import { VerbatimError } from "../command/mod.ts";
import { clientRefusal } from "./client_refusal.ts";
import { configError } from "./errors.ts";
import type { Peer } from "./peer.ts";
import type { ClientMessage, PeerRef, TelegramClient } from "./client.ts";
import type { RawChat } from "./chat.ts";
import { sendMessage, type SendPlan } from "./send.ts";

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

Deno.test("текст уходит одним сообщением", async () => {
  const { client, seen } = stand([message(5000001)]);
  assertEquals(await sendMessage(client, plan()), {
    id: 5000001,
    chatId: 100000001,
    date: "2026-08-16T08:04:09+00:00",
  });
  assertEquals(seen.texts, ["привет"]);
  assertEquals(seen.documents, []);
});

Deno.test("адресат резолвится один раз и до отправки", async () => {
  const { client, seen } = stand([message(5000001)]);
  await sendMessage(
    client,
    plan({ target: "@durov", peer: { kind: "name", name: "durov" } }),
  );
  assertEquals(seen.calls, ["resolve:name", "sendText"]);
});

Deno.test("вложения уходят одним альбомом, подпись — у последнего", async () => {
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
  assertEquals(sent.id, 5000004);
  assertEquals(seen.calls, ["resolve:me", "sendDocuments"]);
  assertEquals(seen.documents, [["a.txt", "b.txt"]]);
  // Подпись несёт последнее вложение, у прочих её нет вовсе.
  assertEquals(seen.captions, [[undefined, "подпись"]]);
  assertEquals(seen.texts, []);
});

Deno.test("пустой текст — вложение без подписи", async () => {
  const { client, seen } = stand([message(5000002)]);
  await sendMessage(
    client,
    plan({
      text: "",
      attachments: [{ name: "a.txt", bytes: new Uint8Array([1]) }],
    }),
  );
  assertEquals(seen.captions, [[undefined]]);
});

Deno.test("--md действует и на текст, и на подпись", async (t) => {
  await t.step("текст", async () => {
    const { client, seen } = stand([message(5000001)]);
    await sendMessage(client, plan({ markdown: true }));
    assertEquals(seen.markdown, [true]);
  });
  await t.step("подпись", async () => {
    const { client, seen } = stand([message(5000002)]);
    await sendMessage(
      client,
      plan({
        markdown: true,
        attachments: [{ name: "a.txt", bytes: new Uint8Array([1]) }],
      }),
    );
    assertEquals(seen.markdown, [true]);
  });
});

Deno.test("времени Telegram не сообщил — date остаётся null", async () => {
  const { client } = stand([message(5000001, { date: null })]);
  assertEquals((await sendMessage(client, plan())).date, null);
});

Deno.test("идентификатора чата нет — отказ операции, а не ноль", async () => {
  const { client } = stand([message(5000001, { chatId: null })]);
  const err = await assertRejects(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: Telegram не сообщил идентификатор чата",
  );
});

Deno.test("адресат-название ищется поиском, а не резолвится напрямую", async () => {
  const { client, seen } = stand([message(5000001)], undefined, [
    { peerType: "supergroup", rawId: 3, title: "Команда", username: null },
  ]);
  await sendMessage(
    client,
    plan({ target: "Команда", peer: { kind: "title", title: "Команда" } }),
  );
  assertEquals(seen.calls, [
    "searchChats:Команда",
    "resolve:id",
    "sendText",
  ]);
});

Deno.test("имени такого нет — вторая попытка ищет чат по названию", async () => {
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
  assertEquals(sent.id, 5000001);
  assertEquals(seen.calls, [
    "resolve:name",
    "searchChats:news",
    "resolve:id",
    "sendText",
  ]);
});

Deno.test("несколько чатов с таким названием — отказ со списком", async () => {
  const { client, seen } = stand([message(5000001)], {
    on: "resolve:name",
    err: refused(new MtPeerNotFoundError("Peer with username news not found")),
  }, [
    { peerType: "supergroup", rawId: 3, title: "news рынка", username: null },
    { peerType: "channel", rawId: 4, title: "news дня", username: null },
  ]);
  const err = await assertRejects(
    () =>
      sendMessage(
        client,
        plan({ target: "news", peer: { kind: "guess", name: "news" } }),
      ),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: под название 'news' подходит несколько чатов: " +
      "'news рынка' → id -1000000000003; 'news дня' → id -1000000000004; " +
      "попробуй: указать адресата по id или @username",
  );
  assertEquals(seen.calls, ["resolve:name", "searchChats:news"]);
});

Deno.test("объявленное имя второй попытки не получает", async () => {
  const { client, seen } = stand([message(5000001)], {
    on: "resolve:name",
    err: refused(new MtPeerNotFoundError("Peer with username durov not found")),
  }, [
    { peerType: "supergroup", rawId: 3, title: "durov", username: null },
  ]);
  const err = await assertRejects(
    () =>
      sendMessage(
        client,
        plan({ target: "@durov", peer: { kind: "name", name: "durov" } }),
      ),
    VerbatimError,
  );
  // Пользователь сам сказал, что это имя, — искать чат с таким названием
  // не за чем.
  assertEquals(seen.calls, ["resolve:name"]);
  assertEquals(
    err.message.startsWith("telegram: не удалось найти чат '@durov'"),
    true,
  );
});

Deno.test("своё оформление отказа резолва без причины — само себе причина", async () => {
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
  const err = await assertRejects(
    () =>
      sendMessage(
        client,
        plan({ target: "@durov", peer: { kind: "name", name: "durov" } }),
      ),
    VerbatimError,
  );
  assertStrictEquals(err.cause, own);
  assertEquals(
    err.message.includes("Telegram вернул адресата без идентификатора"),
    true,
    err.message,
  );
});

Deno.test("название без совпадений — отказ поиска, а не отправка", async () => {
  const { client, seen } = stand([message(5000001)], undefined, []);
  const err = await assertRejects(
    () =>
      sendMessage(
        client,
        plan({ target: "Команда", peer: { kind: "title", title: "Команда" } }),
      ),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: не удалось найти чат 'Команда': совпадений нет; " +
      "попробуй: mpu telegram ls 'Команда' и укажи id или @username",
  );
  assertEquals(seen.calls, ["searchChats:Команда"]);
});

Deno.test("ни имени, ни чата с таким названием — отказ поиска", async () => {
  // То, что увидит пользователь живьём: первая попытка отказала,
  // вторая ничего не нашла.
  const { client, seen } = stand([], {
    on: "resolve:name",
    err: refused(new MtPeerNotFoundError("Peer with username news not found")),
  }, []);
  const err = await assertRejects(
    () =>
      sendMessage(
        client,
        plan({ target: "news", peer: { kind: "guess", name: "news" } }),
      ),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: не удалось найти чат 'news': совпадений нет; " +
      "попробуй: mpu telegram ls 'news' и укажи id или @username",
  );
  assertEquals(seen.calls, ["resolve:name", "searchChats:news"]);
  // Отказ первой попытки не показывается, но и не теряется.
  assertEquals(
    (err.cause as Error).message,
    "Peer with username news not found",
  );
});

Deno.test("имя нашлось — второй попытки не делается", async () => {
  const { client, seen } = stand([message(5000001)], undefined, [
    { peerType: "supergroup", rawId: 3, title: "durov", username: null },
  ]);
  await sendMessage(
    client,
    plan({ target: "durov", peer: { kind: "guess", name: "durov" } }),
  );
  assertEquals(seen.calls, ["resolve:name", "sendText"]);
});

Deno.test("отказ на найденном чате — отказ Telegram, не «не найден»", async () => {
  const flood = refused(
    tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_42" }),
  );
  const { client, seen } = stand([message(5000001)], {
    on: "resolve:id",
    err: flood,
  }, [{ peerType: "supergroup", rawId: 3, title: "news", username: null }]);
  const err = await assertRejects(
    () =>
      sendMessage(
        client,
        plan({ target: "news", peer: { kind: "title", title: "news" } }),
      ),
    VerbatimError,
  );
  // Чат только что нашёлся, его id пришёл от сервера — значит это отказ
  // операции, а не ненайденный адресат.
  assertEquals(err.message, "telegram: rate-limit, подожди 42s");
  assertEquals(seen.calls, ["searchChats:news", "resolve:id"]);
});

Deno.test("отказ отправки не выдаётся за отказ адресата", async () => {
  const { client } = stand([], {
    on: "send",
    err: refused(new tl.RpcError(400, "MEDIA_EMPTY")),
  });
  const err = await assertRejects(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  assertEquals(err.message, "telegram: RPC error: MEDIA_EMPTY");
});

Deno.test("дефект клиента не выдаётся ни за отказ Telegram, ни за «не найден»", async (t) => {
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
    await t.step(name, async () => {
      const defect = new TypeError(`дефект: ${name}`);
      const { client } = stand(
        [message(5000001)],
        { on, err: defect },
        found,
      );
      const err = await assertRejects(() =>
        sendMessage(client, plan({ target, peer }))
      );
      assertStrictEquals(err, defect);
    });
  }
});

Deno.test("отказ двойника без Error уходит как есть", async () => {
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
  assertEquals(outcome, "странный отказ");
});

Deno.test("rate-limit сообщается со сроком ожидания", async () => {
  const flood = refused(
    tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_42" }),
  );
  const { client } = stand([], { on: "send", err: flood });
  const err = await assertRejects(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  assertEquals(err.message, "telegram: rate-limit, подожди 42s");
});
