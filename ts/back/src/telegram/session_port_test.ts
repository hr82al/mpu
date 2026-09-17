/**
 * Граница порта сеанса (`docs/specs/platform/telegram-mtproto.md`, «Что
 * считается отказом Telegram / слоя клиента»): каждый метод сеанса, который
 * зовёт клиента, отдаёт отказ клиента строкой слоя, а прочее — тем же
 * объектом. Сам классификатор проверен отдельно (`client_refusal_test.ts`);
 * здесь закреплено место его вызова — на каждом методе порта, при входе в
 * сеанс и у команды поверх порта.
 *
 * Сети нет: соединение и методы клиента подменены на прототипе
 * высокоуровневого клиента — именно их зовёт `session.ts`.
 */

import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { TelegramClient, tl } from "@mtcute/deno";
import { VerbatimError } from "../command/mod.ts";
import type { EnvFile } from "../command/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { PeerRef } from "./client.ts";
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
  // deno-lint-ignore require-yield
  return async function* () {
    throw err;
  };
}

Deno.test("порт сеанса: отказ клиента — строкой слоя, прочее — тем же объектом", async (t) => {
  for (const method of METHODS) {
    await t.step(
      `${method.name}: дефект своего кода — тот же объект`,
      async () => {
        using _connect = connectedAtOnce();
        using _getMe = stub("getMe", () => Promise.resolve({ id: 42 }));
        const defect = new TypeError(`дефект в ${method.name}`);
        using _failing = stub(method.client, failing(method, defect));
        const session = await openSession(CONFIG);
        try {
          const err = await assertRejects(() => method.call(session));
          assertStrictEquals(err, defect);
        } finally {
          await session.close();
        }
      },
    );
    await t.step(
      `${method.name}: rate-limit клиента — строкой слоя`,
      async () => {
        using _connect = connectedAtOnce();
        using _getMe = stub("getMe", () => Promise.resolve({ id: 42 }));
        using _failing = stub(method.client, failing(method, floodWait()));
        const session = await openSession(CONFIG);
        try {
          const err = await assertRejects(
            () => method.call(session),
            VerbatimError,
          );
          assertEquals(err.message, "telegram: rate-limit, подожди 42s");
        } finally {
          await session.close();
        }
      },
    );
  }
});

Deno.test("вход в сеанс: дефект своего кода при проверке себя — тот же объект", async (t) => {
  await t.step("дефект — тот же объект, не RPC error", async () => {
    using _connect = connectedAtOnce();
    const defect = new TypeError("дефект при проверке себя");
    using _getMe = stub("getMe", () => Promise.reject(defect));
    const err = await assertRejects(() => openSession(CONFIG));
    assertStrictEquals(err, defect);
  });
  await t.step("rate-limit клиента — строкой слоя", async () => {
    using _connect = connectedAtOnce();
    using _getMe = stub("getMe", () => Promise.reject(floodWait()));
    const err = await assertRejects(() => openSession(CONFIG), VerbatimError);
    assertEquals(err.message, "telegram: rate-limit, подожди 42s");
  });
  await t.step("отказ авторизации — «не авторизован»", async () => {
    using _connect = connectedAtOnce();
    using _getMe = stub(
      "getMe",
      () => Promise.reject(new tl.RpcError(401, "AUTH_KEY_UNREGISTERED")),
    );
    const err = await assertRejects(() => openSession(CONFIG), VerbatimError);
    assertEquals(err.message, "telegram: не авторизован; запусти `mpu init`");
  });
});

/** Прогон `mpu telegram ls` поверх подменённого клиента. */
function runLs(): {
  readonly code: Promise<number>;
  readonly stderr: string[];
} {
  const values: Record<string, string> = {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
    TELEGRAM_SESSION: acceptedSession(),
  };
  const envFile: EnvFile = {
    get: (name) => values[name],
    require: (name) => values[name] ?? "",
    set: () => Promise.resolve(),
    values: () => ({ ...values }),
  };
  const stderr: string[] = [];
  const code = runCli(
    ["telegram", "ls", "--limit", "5"],
    makeFakeIo({ envFile }),
    { stdout: () => {}, stderr: (text) => void stderr.push(text) },
  );
  return { code, stderr };
}

Deno.test("mpu telegram ls: дефект клиента — наружу тем же объектом, rate-limit — код 1", async (t) => {
  const listDialogs = METHODS.find((method) => method.name === "listDialogs");
  if (listDialogs === undefined) throw new TypeError("нет метода listDialogs");
  await t.step("дефект — тот же объект из runCli", async () => {
    using _connect = connectedAtOnce();
    using _getMe = stub("getMe", () => Promise.resolve({ id: 42 }));
    const defect = new TypeError("дефект списка диалогов");
    using _failing = stub(listDialogs.client, failing(listDialogs, defect));
    const err = await assertRejects(() => runLs().code);
    assertStrictEquals(err, defect);
  });
  await t.step("rate-limit — код 1 со сроком", async () => {
    using _connect = connectedAtOnce();
    using _getMe = stub("getMe", () => Promise.resolve({ id: 42 }));
    using _failing = stub(
      listDialogs.client,
      failing(listDialogs, floodWait()),
    );
    const ls = runLs();
    assertEquals(await ls.code, 1);
    assertStringIncludes(
      ls.stderr.join(""),
      "telegram: rate-limit, подожди 42s",
    );
  });
});
