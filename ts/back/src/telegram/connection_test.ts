/**
 * Предел соединения с Telegram и поток логов клиента
 * (`docs/specs/platform/telegram-mtproto.md`, «Прокси»): соединение не
 * установлено за 20 с — отказ текстом спеки, у входа — пропуск с тем же
 * текстом; сообщения библиотеки клиента в stdout не пишутся.
 *
 * Наружу не уходит ничего: `Deno.connect` подменён отказом либо соединение и
 * запросы клиента подменены на прототипе, а пределы (20 с, у входа 60 с)
 * отсчитывает `FakeTime`.
 * Переподключения клиента под поддельными часами редки (зонд разбора 132:
 * две попытки к 25 с), так что тишина за предел ничего не доказывает:
 * «клиент погашен» проверяется счётчиком `destroy`, а цикл переподключения
 * по настоящим часам держит smoke-проверка бинаря.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { TelegramClient } from "@mtcute/deno";
import { VerbatimError } from "../command/mod.ts";
import type { EnvFile, Prompt } from "../command/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo, promptQueue } from "../testing/mod.ts";
import { openSession } from "./session.ts";

/** Причина отказа соединения, как её отдаёт Deno. */
const REFUSAL = "Connection refused (os error 111)";

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
function refuseConnections():
  & { readonly attempted: Promise<void> }
  & Disposable {
  const attempted = Promise.withResolvers<void>();
  const realConnect = Deno.connect;
  // `Reflect.set`: у `Deno.connect` три перегрузки, одна подмена на все в
  // их тип не приводится.
  Reflect.set(Deno, "connect", () => {
    attempted.resolve();
    return Promise.reject(new Deno.errors.ConnectionRefused(REFUSAL));
  });
  return {
    attempted: attempted.promise,
    [Symbol.dispose]: () => void Reflect.set(Deno, "connect", realConnect),
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
  const realLevel = Deno.env.get("MTCUTE_LOG_LEVEL");
  console.log = (...args: unknown[]) => void stdout.push(args);
  console.error = (...args: unknown[]) => void stderr.push(args);
  Deno.env.set("MTCUTE_LOG_LEVEL", "5");
  return {
    stdout,
    stderr,
    [Symbol.dispose]: () => {
      console.log = realLog;
      console.error = realError;
      if (realLevel === undefined) Deno.env.delete("MTCUTE_LOG_LEVEL");
      else Deno.env.set("MTCUTE_LOG_LEVEL", realLevel);
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

/** Прогон команды: env-файл в памяти, телефон вводится с терминала. */
function run(
  argv: readonly string[],
  values: Record<string, string>,
): {
  readonly code: Promise<number>;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly written: Record<string, string>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const written: Record<string, string> = {};
  const envFile: EnvFile = {
    get: (name) => values[name],
    require: (name) => values[name] ?? "",
    set: (name, value) => {
      written[name] = value;
      values[name] = value;
      return Promise.resolve();
    },
    values: () => ({ ...values }),
  };
  const answers = ["+70001112233"];
  const prompt: Prompt = promptQueue(answers);
  const code = runCli(
    argv,
    makeFakeIo({ envFile, prompt }),
    {
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
    },
  );
  return { code, stdout, stderr, written };
}

/**
 * Прогоняет часы до предела и требует, чтобы операция к этому моменту
 * завершилась: без предела тест краснеет здесь, а не висит.
 */
async function expireLimit(
  time: FakeTime,
  operation: { readonly settled: () => boolean },
  limitMs = 20_000,
): Promise<void> {
  const seconds = limitMs / 1000;
  await time.tickAsync(limitMs - 1);
  await drain(time, operation);
  assertEquals(operation.settled(), false, `отказ пришёл раньше ${seconds} с`);
  await time.tickAsync(1);
  await drain(time, operation);
  assertEquals(operation.settled(), true, `за ${seconds} с отказа нет`);
}

/**
 * Даёт отказу дойти до вызывающего: между срабатыванием таймера и
 * завершением операции клиент ещё закрывается, и это несколько оборотов
 * микрозадач. Без этого проверка «раньше предела отказа нет» смотрела бы
 * до того, как отказ успел бы прийти, и молчала бы на слишком коротком
 * пределе.
 */
async function drain(
  time: FakeTime,
  operation: { readonly settled: () => boolean },
): Promise<void> {
  for (let turn = 0; turn < 20 && !operation.settled(); turn++) {
    await time.runMicrotasks();
  }
}

Deno.test("сеанс: нет соединения за 20 с — отказ текстом спеки, ровно на пределе", async () => {
  using time = new FakeTime();
  using refused = refuseConnections();
  using _logs = captureClientLogs();
  const opening = track(
    openSession({ apiId: 1, apiHash: "проба", session: acceptedSession() }),
  );
  await Promise.race([refused.attempted, opening.done]);
  await expireLimit(time, opening);
  const outcome = await opening.done;
  assertEquals(outcome instanceof VerbatimError, true, String(outcome));
  assertEquals((outcome as VerbatimError).message, LIMIT_TEXT);
});

Deno.test("mpu telegram ls: нет соединения — код 1 с текстом спеки, stdout без лога клиента", async () => {
  using time = new FakeTime();
  using refused = refuseConnections();
  using logs = captureClientLogs();
  const ls = run(["telegram", "ls", "--limit", "1"], {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
    TELEGRAM_SESSION: acceptedSession(),
  });
  const code = track(ls.code);
  await Promise.race([refused.attempted, code.done]);
  await expireLimit(time, code);
  assertEquals(await code.done, 1, ls.stderr.join(""));
  assertStringIncludes(ls.stderr.join(""), LIMIT_TEXT);
  assertEquals(ls.stdout, []);
  // Библиотека писала — и не в stdout процесса.
  assertEquals(logs.stdout, [], "лог клиента ушёл в stdout");
  assertEquals(logs.stderr.length > 0, true, "лог клиента не писался вовсе");
});

Deno.test("mpu telegram login: нет соединения — пропуск с тем же текстом, код 0", async () => {
  using time = new FakeTime();
  using refused = refuseConnections();
  using _logs = captureClientLogs();
  const login = run(["telegram", "login"], {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
  });
  const code = track(login.code);
  await Promise.race([refused.attempted, code.done]);
  await expireLimit(time, code);
  const stderr = login.stderr.join("");
  assertEquals(await code.done, 0, stderr);
  assertStringIncludes(stderr, `# telegram: пропущено (${LIMIT_TEXT})\n`);
  assertEquals(login.written, { TELEGRAM_PHONE: "+70001112233" });
});

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

Deno.test("сеанс: соединение есть, ответа нет за 20 с — отказ текстом спеки, клиент погашен", async (t) => {
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
    await t.step(name, async () => {
      using time = new FakeTime();
      using _refused = refuseConnections();
      using _logs = captureClientLogs();
      using _connect = connectedAtOnce();
      using destroys = countDestroys();
      using silent = silentRequest("getMe", before);
      const opening = track(
        openSession({ apiId: 1, apiHash: "проба", session: acceptedSession() }),
      );
      await Promise.race([silent.asked, opening.done]);
      await expireLimit(time, opening);
      const outcome = await opening.done;
      assertEquals(outcome instanceof VerbatimError, true, String(outcome));
      assertEquals((outcome as VerbatimError).message, text);
      assertEquals(destroys.count(), 1, "клиент не погашен ровно раз");
    });
  }
});

Deno.test("сеанс: отказ по пределу соединения — клиент погашен ровно раз", async () => {
  using time = new FakeTime();
  using refused = refuseConnections();
  using _logs = captureClientLogs();
  using destroys = countDestroys();
  const opening = track(
    openSession({ apiId: 1, apiHash: "проба", session: acceptedSession() }),
  );
  await Promise.race([refused.attempted, opening.done]);
  await expireLimit(time, opening);
  assertEquals(await opening.done instanceof VerbatimError, true);
  assertEquals(destroys.count(), 1, "клиент не погашен ровно раз");
});

Deno.test("сеанс: успех — пределы и подписки сняты, таймеров от вызова нет", async () => {
  // Неснятый таймер предела ничем не проявляется: он лишь разрешает
  // обещание, которого никто не ждёт, а санитайзер теста таймеров не
  // считает. Поэтому признак — поддельные часы: после входа у них не
  // остаётся ни одного запланированного таймера (`time.next()`).
  using time = new FakeTime();
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
    assertEquals(time.next(), false, "после входа остался таймер");
    // Время за пределами обоих пределов: отказа нет, сеанс цел.
    await time.tickAsync(40_000);
    assertEquals(entered?.onError.length, 0, "подписка на ошибки не снята");
    assertEquals(
      entered?.onConnectionState.length,
      0,
      "подписка на состояние не снята",
    );
  } finally {
    await session.close();
  }
});

Deno.test("mpu telegram login: соединение есть, ответа нет — пропуск с текстом спеки, код 0", async () => {
  using time = new FakeTime();
  using _refused = refuseConnections();
  using _logs = captureClientLogs();
  using _connect = connectedAtOnce();
  using destroys = countDestroys();
  using silent = silentRequest("start");
  const login = run(["telegram", "login"], {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
  });
  const code = track(login.code);
  await Promise.race([silent.asked, code.done]);
  // У входа предел первого ответа — 60 с (спека: смена DC и flood-wait).
  await expireLimit(time, code, 60_000);
  const stderr = login.stderr.join("");
  assertEquals(await code.done, 0, stderr);
  assertStringIncludes(
    stderr,
    "# telegram: пропущено (telegram: нет ответа от Telegram за 60 с: узел не ответил)\n",
  );
  // Рендер входа — пустой текст: запись есть, но stdout пуст.
  assertEquals(login.stdout.join(""), "");
  assertEquals(destroys.count(), 1, "клиент не погашен ровно раз");
});
