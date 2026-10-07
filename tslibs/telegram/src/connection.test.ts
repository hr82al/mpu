/**
 * Пределы соединения и первого ответа Telegram
 * (`platform/telegram-mtproto.md`, «Прокси»): не дождались за предел —
 * отказ текстом спеки у сеанса и у входа, клиент погашен. Что из отказа
 * делает команда (код, пропуск входа, stdout без лога клиента), проверяют
 * тесты потребителя.
 *
 * Наружу не уходит ничего: `connect` сокета подменён отказом либо соединение
 * и запросы клиента подменены на прототипе, а пределы (20 с, у входа 60 с)
 * отсчитывают поддельные часы Vitest.
 * Переподключения клиента под поддельными часами редки (зонд разбора 132:
 * две попытки к 25 с), так что тишина за предел ничего не доказывает:
 * «клиент погашен» проверяется счётчиком `destroy`, а цикл переподключения
 * по настоящим часам держит smoke-проверка бинаря.
 */

import { Socket } from "node:net";
import process from "node:process";
import { TelegramClient } from "@mtcute/node";
import { describe, expect, it, vi } from "vitest";
import { TelegramError } from "./errors.ts";
import { openLoginClient } from "./login_client.ts";
import { openSession } from "./session.ts";

/** Причина отказа соединения, как её отдаёт `node:net`. */
const REFUSAL = "connect ECONNREFUSED 127.0.0.1:1";

/** Строка отказа по спеке — предел назван в ней числом. */
const LIMIT_TEXT = `telegram: нет соединения с Telegram за 20 с: ${REFUSAL}`;

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

/** Каждое соединение отказывает; первая попытка отмечается. */
function refuseConnections(): {
  readonly attempted: Promise<void>;
} & Disposable {
  const attempted = Promise.withResolvers<void>();
  const realConnect = Socket.prototype.connect;
  // `Reflect.set`: у `connect` сокета несколько перегрузок, одна подмена на
  // все в их тип не приводится. Отказ — событием на следующем обороте, как
  // у настоящего сокета: слушатель `error` клиент вешает после `connect`.
  Reflect.set(Socket.prototype, "connect", function (this: Socket) {
    attempted.resolve();
    const refusal = Object.assign(new Error(REFUSAL), {
      code: "ECONNREFUSED",
    });
    process.nextTick(() => this.destroy(refusal));
    return this;
  });
  return {
    attempted: attempted.promise,
    [Symbol.dispose]: () =>
      void Reflect.set(Socket.prototype, "connect", realConnect),
  };
}

/**
 * Куда пишет библиотека клиента. Уровень логов поднят до подробного, чтобы
 * писать ей было что: при уровне по умолчанию проверка потока молчала бы.
 */
function captureClientLogs(): {
  readonly stdout: unknown[][];
  readonly stderr: unknown[][];
} & Disposable {
  const stdout: unknown[][] = [];
  const stderr: unknown[][] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void stdout.push(args);
  console.error = (...args: unknown[]) => void stderr.push(args);
  vi.stubEnv("MTCUTE_LOG_LEVEL", "5");
  return {
    stdout,
    stderr,
    [Symbol.dispose]: () => {
      console.log = realLog;
      console.error = realError;
      vi.unstubAllEnvs();
    },
  };
}

/** Промис, о котором можно спросить, завершился ли он, не дожидаясь его. */
function track<T>(promise: Promise<T>): {
  readonly done: Promise<T | unknown>;
  readonly settled: () => boolean;
} {
  let settled = false;
  const done = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (err: unknown) => {
      settled = true;
      return err;
    },
  );
  return { done, settled: () => settled };
}

/**
 * Прогоняет часы до предела и требует, чтобы операция к этому моменту
 * завершилась: без предела тест краснеет здесь, а не висит.
 */
async function expireLimit(
  operation: { readonly settled: () => boolean },
  limitMs = 20_000,
): Promise<void> {
  const seconds = limitMs / 1000;
  await vi.advanceTimersByTimeAsync(limitMs - 1);
  await drain(operation);
  expect(operation.settled(), `отказ пришёл раньше ${seconds} с`).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await drain(operation);
  expect(operation.settled(), `за ${seconds} с отказа нет`).toBe(true);
}

/**
 * Даёт отказу дойти до вызывающего: между срабатыванием таймера и
 * завершением операции клиент ещё закрывается, и это несколько оборотов
 * микрозадач. Без этого проверка «раньше предела отказа нет» смотрела бы
 * до того, как отказ успел бы прийти, и молчала бы на слишком коротком
 * пределе. Оборот — сдвиг часов на ноль: он отдаёт ход циклу событий, и
 * отказы сокета (`process.nextTick`) доходят тоже.
 */
async function drain(operation: {
  readonly settled: () => boolean;
}): Promise<void> {
  for (let turn = 0; turn < 20 && !operation.settled(); turn++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

it("сеанс: нет соединения за 20 с — отказ текстом спеки, ровно на пределе", async () => {
  using _time = fakeTime();
  using refused = refuseConnections();
  using _logs = captureClientLogs();
  const opening = track(
    openSession({ apiId: 1, apiHash: "проба", session: acceptedSession() }),
  );
  await Promise.race([refused.attempted, opening.done]);
  await expireLimit(opening);
  const outcome = await opening.done;
  expect(outcome instanceof TelegramError, String(outcome)).toBe(true);
  expect((outcome as TelegramError).message).toBe(LIMIT_TEXT);
});

/** Поддельные часы на время теста; снятие — возврат настоящих. */
function fakeTime(): Disposable {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}

/**
 * Подменяет метод на прототипе клиента на время теста. Метод, лежавший
 * выше по цепочке, возвращается снятием подмены, а не записью копии.
 */
function stubClient(
  name: "connect" | "getMe" | "start" | "destroy",
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

/** Соединение подменено: сокет «открыт» сразу, сети нет. */
function connectedAtOnce(): Disposable {
  return stubClient("connect", function () {
    this.onConnectionState.emit("connected");
    return Promise.resolve();
  });
}

/** Сколько раз клиента погасили; настоящее закрытие исполняется. */
function countDestroys(): { readonly count: () => number } & Disposable {
  let count = 0;
  const real = TelegramClient.prototype.destroy;
  const stub = stubClient("destroy", function () {
    count++;
    return real.call(this);
  });
  return { count: () => count, [Symbol.dispose]: () => stub[Symbol.dispose]() };
}

/** Запрос, на который ответа нет; первый вызов отмечается. */
function silentRequest(
  name: "getMe" | "start",
  before: (client: TelegramClient) => void = () => {},
): { readonly asked: Promise<void> } & Disposable {
  const asked = Promise.withResolvers<void>();
  const stub = stubClient(name, function () {
    before(this);
    asked.resolve();
    return new Promise<never>(() => {});
  });
  return {
    asked: asked.promise,
    [Symbol.dispose]: () => stub[Symbol.dispose](),
  };
}

describe("сеанс: соединение есть, ответа нет за 20 с — отказ текстом спеки, клиент погашен", () => {
  const cases = [
    {
      name: "узел молчит — узел не ответил",
      before: () => {},
      text: "telegram: нет ответа от Telegram за 20 с: узел не ответил",
    },
    {
      name: "узел рвёт соединение — первая строка срыва",
      before: (client: TelegramClient) =>
        client.onError.emit(new Error("срыв соединения\nподробности")),
      text: "telegram: нет ответа от Telegram за 20 с: срыв соединения",
    },
  ];
  for (const { name, before, text } of cases) {
    it(name, async () => {
      using _time = fakeTime();
      using _refused = refuseConnections();
      using _logs = captureClientLogs();
      using _connect = connectedAtOnce();
      using destroys = countDestroys();
      using silent = silentRequest("getMe", before);
      const opening = track(
        openSession({ apiId: 1, apiHash: "проба", session: acceptedSession() }),
      );
      await Promise.race([silent.asked, opening.done]);
      await expireLimit(opening);
      const outcome = await opening.done;
      expect(outcome instanceof TelegramError, String(outcome)).toBe(true);
      expect((outcome as TelegramError).message).toBe(text);
      expect(destroys.count(), "клиент не погашен ровно раз").toBe(1);
    });
  }
});

it("сеанс: отказ по пределу соединения — клиент погашен ровно раз", async () => {
  using _time = fakeTime();
  using refused = refuseConnections();
  using _logs = captureClientLogs();
  using destroys = countDestroys();
  const opening = track(
    openSession({ apiId: 1, apiHash: "проба", session: acceptedSession() }),
  );
  await Promise.race([refused.attempted, opening.done]);
  await expireLimit(opening);
  expect((await opening.done) instanceof TelegramError).toBe(true);
  expect(destroys.count(), "клиент не погашен ровно раз").toBe(1);
});

it("сеанс: успех — пределы и подписки сняты, таймеров от вызова нет", async () => {
  // Неснятый таймер предела ничем не проявляется: он лишь разрешает
  // обещание, которого никто не ждёт, а санитайзер теста таймеров не
  // считает. Поэтому признак — поддельные часы: после входа у них не
  // остаётся ни одного запланированного таймера (`vi.getTimerCount()`).
  using _time = fakeTime();
  using _refused = refuseConnections();
  using _logs = captureClientLogs();
  let entered: TelegramClient | undefined;
  using _connect = stubClient("connect", function () {
    entered = this;
    this.onConnectionState.emit("connected");
    return Promise.resolve();
  });
  using _getMe = stubClient("getMe", () => Promise.resolve({ id: 42 }));
  const session = await openSession({
    apiId: 1,
    apiHash: "проба",
    session: acceptedSession(),
  });
  try {
    expect(vi.getTimerCount(), "после входа остался таймер").toBe(0);
    // Время за пределами обоих пределов: отказа нет, сеанс цел.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(entered?.onError.length, "подписка на ошибки не снята").toBe(0);
    expect(
      entered?.onConnectionState.length,
      "подписка на состояние не снята",
    ).toBe(0);
  } finally {
    await session.close();
  }
});

// Имя случая — прежнее (список случаев до переезда = после): пропуск с
// кодом 0 и строкой `# telegram: пропущено (…)` делает сценарий входа
// потребителя из этого отказа — здесь проверяется сам отказ входа.
it("mpu telegram login: соединение есть, ответа нет — пропуск с текстом спеки, код 0", async () => {
  using _time = fakeTime();
  using _refused = refuseConnections();
  using _logs = captureClientLogs();
  using _connect = connectedAtOnce();
  using destroys = countDestroys();
  using silent = silentRequest("start");
  const client = openLoginClient({ apiId: "1", apiHash: "проба" }, undefined);
  const signing = track(
    client.signIn("+70001112233", {
      ask: () => Promise.resolve(undefined),
      askSecret: () => Promise.resolve(undefined),
      progress: () => {},
    }),
  );
  await Promise.race([silent.asked, signing.done]);
  // У входа предел первого ответа — 60 с (спека: смена DC и flood-wait).
  await expireLimit(signing, 60_000);
  const outcome = await signing.done;
  // Закрывает вызывающий — как сценарий входа в `finally`.
  await client.close();
  expect(outcome instanceof TelegramError, String(outcome)).toBe(true);
  expect((outcome as TelegramError).message).toBe(
    "telegram: нет ответа от Telegram за 60 с: узел не ответил",
  );
  expect(destroys.count(), "клиент не погашен ровно раз").toBe(1);
});
