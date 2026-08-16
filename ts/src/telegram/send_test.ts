import { assertEquals, assertRejects } from "@std/assert";
import { VerbatimError } from "../command/mod.ts";
import type { Peer } from "./peer.ts";
import {
  type ClientMessage,
  type PeerRef,
  sendMessage,
  type SendPlan,
  type TelegramClient,
} from "./send.ts";

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
  fail?: { readonly on: "resolve" | "send"; readonly err: Error },
): { readonly client: TelegramClient; readonly seen: Seen } {
  const seen: Seen = {
    calls: [],
    texts: [],
    captions: [],
    markdown: [],
    documents: [],
  };
  const ref: PeerRef = { ref: "peer" };
  const client: TelegramClient = {
    resolve: (peer: Peer) => {
      seen.calls.push(`resolve:${peer.kind}`);
      if (fail?.on === "resolve") return Promise.reject(fail.err);
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

Deno.test("отказ резолва называет адресата и подсказывает ls", async () => {
  const { client } = stand([], {
    on: "resolve",
    err: new Error("chat not found"),
  });
  const err = await assertRejects(
    () =>
      sendMessage(
        client,
        plan({ target: "команда", peer: { kind: "name", name: "команда" } }),
      ),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: не удалось найти чат 'команда': chat not found; " +
      "попробуй: mpu telegram ls 'команда' и укажи id или @username",
  );
});

Deno.test("отказ отправки не выдаётся за отказ адресата", async () => {
  const { client } = stand([], {
    on: "send",
    err: new Error("MEDIA_EMPTY"),
  });
  const err = await assertRejects(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  assertEquals(err.message, "telegram: RPC error: MEDIA_EMPTY");
});

Deno.test("текст отказа берётся из поля протокола, а не из message", async () => {
  const rpc = Object.assign(new Error("RPC_CALL_FAIL"), {
    code: 400,
    text: "CHAT_WRITE_FORBIDDEN",
  });
  const { client } = stand([], { on: "send", err: rpc });
  const err = await assertRejects(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  assertEquals(err.message, "telegram: RPC error: CHAT_WRITE_FORBIDDEN");
});

Deno.test("отказ без Error оформляется той же строкой", async () => {
  const { client } = stand([], {
    on: "send",
    // Не-Error бросают редко, но молча потерять такой отказ нельзя.
    err: "странный отказ" as unknown as Error,
  });
  const err = await assertRejects(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  assertEquals(err.message, "telegram: RPC error: странный отказ");
});

Deno.test("rate-limit сообщается со сроком ожидания", async () => {
  const flood = Object.assign(new Error("FLOOD_WAIT"), { seconds: 42 });
  const { client } = stand([], { on: "send", err: flood });
  const err = await assertRejects(
    () => sendMessage(client, plan()),
    VerbatimError,
  );
  assertEquals(err.message, "telegram: rate-limit, подожди 42s");
});
