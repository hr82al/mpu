/**
 * Предел соединения с Telegram и поток логов клиента
 * (`docs/specs/platform/telegram-mtproto.md`, «Прокси»): соединение не
 * установлено за 20 с — отказ текстом спеки, у входа — пропуск с тем же
 * текстом; сообщения библиотеки клиента в stdout не пишутся.
 *
 * Наружу не уходит ничего: `Deno.connect` подменён отказом, а 20 с
 * отсчитывает `FakeTime` — клиент берёт `setTimeout` в момент вызова, так
 * что и его паузы переподключения идут по поддельным часам.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { VerbatimError } from "../command/mod.ts";
import type { EnvFile, TerminalIo } from "../command/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
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
  const terminal: TerminalIo = {
    name: undefined,
    write: () => Promise.resolve(),
    readLine: () => Promise.resolve(answers.shift()),
    readSecret: () => Promise.resolve(undefined),
    [Symbol.dispose]: () => {},
  };
  const code = runCli(
    argv,
    makeFakeIo({ envFile, openTerminal: () => Promise.resolve(terminal) }),
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
): Promise<void> {
  await time.tickAsync(19_999);
  await drain(time, operation);
  assertEquals(operation.settled(), false, "отказ пришёл раньше 20 с");
  await time.tickAsync(1);
  await drain(time, operation);
  assertEquals(operation.settled(), true, "за 20 с отказа нет");
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
