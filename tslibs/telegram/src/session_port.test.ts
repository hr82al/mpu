/**
 * Граница порта сеанса (`platform/telegram-mtproto.md`, «Что
 * считается отказом Telegram / слоя клиента»): каждый метод сеанса, который
 * зовёт клиента, отдаёт отказ клиента строкой слоя, а прочее — тем же
 * объектом. Сам классификатор проверен отдельно (`client_refusal.test.ts`);
 * здесь закреплено место его вызова — на каждом методе порта, при входе в
 * сеанс и у команды поверх порта.
 *
 * Сети нет: соединение и методы клиента подменены на прототипе
 * высокоуровневого клиента — именно их зовёт `session.ts`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Long, Message, PeersIndex, TelegramClient, tl } from "@mtcute/node";
import { rejected } from "@mpu/testing/thrown";
import type { PeerRef } from "./client.ts";
import { TelegramError } from "./errors.ts";
import { Inbox } from "./inbox.ts";
import { openSession, type TelegramSession } from "./session.ts";

/**
 * Строка сессии в формате прежней реализации, указывающая на петлю:
 * импорт её принимает, и дело доходит до соединения.
 */
function acceptedSession(): string {
  const bytes = new Uint8Array(1 + 4 + 2 + 256);
  bytes.set([2, 127, 0, 0, 1, 0, 1]);
  const base64 = btoa(String.fromCharCode(...bytes));
  return `1${base64.replaceAll("+", "-").replaceAll("/", "_")}`;
}

/**
 * Rate-limit в том виде, в каком клиент создаёт отказ из ответа Telegram
 * (`fromTl`): срок ожидания разобран в поле `seconds`. Конструктор его не
 * разбирает — такой двойник был бы сочинённым.
 */
function floodWait(): tl.RpcError {
  return tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_42" });
}

/**
 * Подменяет метод на прототипе клиента на время теста. Метод, лежавший
 * выше по цепочке, возвращается снятием подмены, а не записью копии.
 */
function stub(
  name: string,
  impl: (this: TelegramClient, ...args: never[]) => unknown,
): Disposable {
  const proto = TelegramClient.prototype;
  const own = Object.hasOwn(proto, name);
  const real: unknown = Reflect.get(proto, name);
  Reflect.set(proto, name, impl);
  return {
    [Symbol.dispose]: () =>
      void (own
        ? Reflect.set(proto, name, real)
        : Reflect.deleteProperty(proto, name)),
  };
}

/** Сокет «открыт» сразу: соединение подменено, сети нет. */
function connectedAtOnce(): Disposable {
  return stub("connect", function () {
    this.onConnectionState.emit("connected");
    return Promise.resolve();
  });
}

const CONFIG = { apiId: 1, apiHash: "проба", session: acceptedSession() };

const PEER: PeerRef = { ref: { _: "inputPeerSelf" }, id: 42 };

/** Сообщение с документом — тем, что клиент собирает из ответа Telegram. */
const DOCUMENT = new Message(
  {
    _: "message",
    id: 42,
    peerId: { _: "peerUser", userId: 42 },
    date: 1_790_000_000,
    message: "",
    media: {
      _: "messageMediaDocument",
      document: {
        _: "document",
        id: Long.fromNumber(1),
        accessHash: Long.fromNumber(2),
        fileReference: new Uint8Array(),
        date: 1_790_000_000,
        mimeType: "text/markdown",
        size: 4,
        dcId: 2,
        attributes: [{ _: "documentAttributeFilename", fileName: "a.md" }],
      },
    },
  },
  new PeersIndex(),
);

/** Метод порта, метод клиента под ним и то, как метод клиента отказывает. */
interface PortMethod {
  readonly name: string;
  readonly client: string;
  readonly iterates: boolean;
  readonly call: (session: TelegramSession) => Promise<unknown>;
}

const METHODS: readonly PortMethod[] = [
  {
    name: "resolve",
    client: "resolvePeer",
    iterates: false,
    call: (session) => session.resolve({ kind: "name", name: "news" }),
  },
  {
    name: "sendText",
    client: "sendText",
    iterates: false,
    call: (session) => session.sendText(PEER, "текст", false),
  },
  {
    name: "sendDocuments",
    client: "sendMedia",
    iterates: false,
    call: (session) =>
      session.sendDocuments(
        PEER,
        [{ name: "a.txt", bytes: new Uint8Array([1]) }],
        false,
      ),
  },
  {
    name: "listDialogs",
    client: "iterDialogs",
    iterates: true,
    call: (session) => session.listDialogs(5),
  },
  {
    name: "searchChats",
    client: "call",
    iterates: false,
    call: (session) => session.searchChats("news", 5),
  },
  {
    name: "searchInChat",
    client: "iterSearchMessages",
    iterates: true,
    call: (session) =>
      session.searchInChat({ chat: PEER, query: "q", from: null, limit: 5 }),
  },
  {
    name: "messageFile",
    client: "getMessages",
    iterates: false,
    call: (session) => session.messageFile(PEER, 42),
  },
  {
    // Скачивание идёт итерацией по ходу записи: отказ обязан прийти
    // строкой слоя и посреди потока, а не только при запросе сообщения.
    name: "messageFile → saveTo",
    client: "downloadAsIterable",
    iterates: true,
    call: async (session) => {
      using _found = stub("getMessages", () => Promise.resolve([DOCUMENT]));
      const dir = await mkdtemp(join(tmpdir(), "session-port-"));
      try {
        const file = await session.messageFile(PEER, 42);
        return await file.saveTo(new Inbox(dir), 42);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "searchGlobal",
    client: "iterSearchGlobal",
    iterates: true,
    call: async (session) => {
      const found: unknown[] = [];
      for await (const message of session.searchGlobal("q")) {
        found.push(message);
      }
      return found;
    },
  },
];

/** Метод клиента, отказывающий заданной ошибкой — промисом или итерацией. */
function failing(
  method: PortMethod,
  err: unknown,
): (this: TelegramClient) => unknown {
  if (!method.iterates) return () => Promise.reject(err);
  // Поток, отказывающий на первом же шаге итерации.
  return () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
  });
}

describe("порт сеанса: отказ клиента — строкой слоя, прочее — тем же объектом", () => {
  for (const method of METHODS) {
    it(`${method.name}: дефект своего кода — тот же объект`, async () => {
      using _connect = connectedAtOnce();
      using _getMe = stub("getMe", () => Promise.resolve({ id: 42 }));
      const defect = new TypeError(`дефект в ${method.name}`);
      using _failing = stub(method.client, failing(method, defect));
      const session = await openSession(CONFIG);
      try {
        const err = await rejected(() => method.call(session), Error);
        expect(err).toBe(defect);
      } finally {
        await session.close();
      }
    });
    it(`${method.name}: rate-limit клиента — строкой слоя`, async () => {
      using _connect = connectedAtOnce();
      using _getMe = stub("getMe", () => Promise.resolve({ id: 42 }));
      using _failing = stub(method.client, failing(method, floodWait()));
      const session = await openSession(CONFIG);
      try {
        const err = await rejected(() => method.call(session), TelegramError);
        expect(err.message).toStrictEqual("telegram: rate-limit, подожди 42s");
      } finally {
        await session.close();
      }
    });
  }
});

describe("вход в сеанс: дефект своего кода при проверке себя — тот же объект", () => {
  it("дефект — тот же объект, не RPC error", async () => {
    using _connect = connectedAtOnce();
    const defect = new TypeError("дефект при проверке себя");
    using _getMe = stub("getMe", () => Promise.reject(defect));
    const err = await rejected(() => openSession(CONFIG), Error);
    expect(err).toBe(defect);
  });
  it("rate-limit клиента — строкой слоя", async () => {
    using _connect = connectedAtOnce();
    using _getMe = stub("getMe", () => Promise.reject(floodWait()));
    const err = await rejected(() => openSession(CONFIG), TelegramError);
    expect(err.message).toStrictEqual("telegram: rate-limit, подожди 42s");
  });
  it("отказ авторизации — «не авторизован»", async () => {
    using _connect = connectedAtOnce();
    using _getMe = stub("getMe", () =>
      Promise.reject(new tl.RpcError(401, "AUTH_KEY_UNREGISTERED")),
    );
    const err = await rejected(() => openSession(CONFIG), TelegramError);
    expect(err.message).toStrictEqual(
      "telegram: не авторизован; запусти `mpu init`",
    );
  });
});

/** Метод порта `listDialogs`, на котором держится `mpu telegram ls`. */
function listDialogsMethod(): PortMethod {
  const found = METHODS.find((method) => method.name === "listDialogs");
  if (found === undefined) throw new TypeError("нет метода listDialogs");
  return found;
}

// Имена случаев — прежние (список случаев до переезда = после): команда
// `mpu telegram ls` — это `listDialogs` открытого сеанса, а код выхода по
// классу отказа (`TelegramError` — 1) назначает потребитель.
describe("mpu telegram ls: дефект клиента — наружу тем же объектом, rate-limit — код 1", () => {
  it("дефект — тот же объект из runCli", async () => {
    using _connect = connectedAtOnce();
    using _getMe = stub("getMe", () => Promise.resolve({ id: 42 }));
    const listDialogs = listDialogsMethod();
    const defect = new TypeError("дефект списка диалогов");
    using _failing = stub(listDialogs.client, failing(listDialogs, defect));
    const session = await openSession(CONFIG);
    try {
      const err = await rejected(() => listDialogs.call(session), Error);
      expect(err).toBe(defect);
    } finally {
      await session.close();
    }
  });
  it("rate-limit — код 1 со сроком", async () => {
    using _connect = connectedAtOnce();
    using _getMe = stub("getMe", () => Promise.resolve({ id: 42 }));
    const listDialogs = listDialogsMethod();
    using _failing = stub(
      listDialogs.client,
      failing(listDialogs, floodWait()),
    );
    const session = await openSession(CONFIG);
    try {
      const err = await rejected(
        () => listDialogs.call(session),
        TelegramError,
      );
      expect(err.message).toStrictEqual("telegram: rate-limit, подожди 42s");
    } finally {
      await session.close();
    }
  });
});
