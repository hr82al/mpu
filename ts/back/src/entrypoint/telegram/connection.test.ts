/**
 * Предел соединения с Telegram и поток логов клиента у команд
 * (`docs/specs/platform/telegram-mtproto.md`, «Прокси»): соединение не
 * установлено за 20 с — код 1 с текстом спеки, у входа — пропуск с тем же
 * текстом и код 0; сообщения библиотеки клиента в stdout не пишутся. Пределы
 * самого сеанса и входа проверяет `@mpu/telegram`.
 *
 * Наружу не уходит ничего: `connect` сокета подменён отказом, а предел
 * отсчитывают поддельные часы Vitest. Цикл переподключения по настоящим
 * часам держит smoke-проверка бинаря.
 */

import { Socket } from "node:net";
import process from "node:process";
import { expect, it, vi } from "vitest";
import type { EnvFile, Prompt } from "@mpu/command";
import { runCli } from "../mod.ts";
import { makeFakeIo, promptQueue } from "@mpu/command/testing";

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
  const code = runCli(argv, makeFakeIo({ envFile, prompt }), {
    stdout: (text) => void stdout.push(text),
    stderr: (text) => void stderr.push(text),
  });
  return { code, stdout, stderr, written };
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

it("mpu telegram ls: нет соединения — код 1 с текстом спеки, stdout без лога клиента", async () => {
  using _time = fakeTime();
  using refused = refuseConnections();
  using logs = captureClientLogs();
  const ls = run(["telegram", "ls", "--limit", "1"], {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
    TELEGRAM_SESSION: acceptedSession(),
  });
  const code = track(ls.code);
  await Promise.race([refused.attempted, code.done]);
  await expireLimit(code);
  expect(await code.done, ls.stderr.join("")).toBe(1);
  expect(ls.stderr.join("")).toContain(LIMIT_TEXT);
  expect(ls.stdout).toStrictEqual([]);
  // Библиотека писала — и не в stdout процесса.
  expect(logs.stdout, "лог клиента ушёл в stdout").toStrictEqual([]);
  expect(logs.stderr.length > 0, "лог клиента не писался вовсе").toBe(true);
});

it("mpu telegram login: нет соединения — пропуск с тем же текстом, код 0", async () => {
  using _time = fakeTime();
  using refused = refuseConnections();
  using _logs = captureClientLogs();
  const login = run(["telegram", "login"], {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
  });
  const code = track(login.code);
  await Promise.race([refused.attempted, code.done]);
  await expireLimit(code);
  const stderr = login.stderr.join("");
  expect(await code.done, stderr).toBe(0);
  expect(stderr).toContain(`# telegram: пропущено (${LIMIT_TEXT})\n`);
  expect(login.written).toStrictEqual({ TELEGRAM_PHONE: "+70001112233" });
});

/** Поддельные часы на время теста; снятие — возврат настоящих. */
function fakeTime(): Disposable {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => void vi.useRealTimers() };
}
