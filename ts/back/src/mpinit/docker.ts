/**
 * Порт docker для `mpu mp-init` и его настоящая реализация.
 *
 * Вызовов два вида, и различаются они не тем, что запускается, а тем,
 * кому нужен вывод: пробе (inspect, `config --services`, `wait`, `logs`,
 * счёт миграций) вывод нужен нам — он разбирается; мутации (create,
 * build, up, stop) — оператору, и docker пишет его в терминал сам.
 * Третий вид — мутация, чей вывод нужен обоим (заполнение курсов валют:
 * оператор смотрит ход, команда ищет пропущенные дни).
 */

import { writeSync } from "node:fs";
import { hasErrorCode } from "@mpu/base/oserror";
import { runProgram, startProgram } from "@mpu/subprocess";

/** Дескриптор stderr процесса: эхо пишется в него синхронно. */
const STDERR = 2;

/** Итог пробы: код и собранные потоки. */
export interface ProcessOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Что мутация получает кроме argv: окружение и stdin. */
export interface RunInput {
  /** Переменные поверх окружения процесса `mpu`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Текст в stdin — единственный путь секрета (пароль входа). */
  readonly stdin?: string;
}

/** Запуск docker-процессов команды. */
export interface Docker {
  /**
   * Читающий вызов с захватом вывода. `signal` прерывает ожидание —
   * процесс снимается, исход всё равно приходит значением.
   */
  probe(
    argv: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProcessOutcome>;
  /** Мутация: вывод идёт в терминал как есть, наружу — только код. */
  run(argv: readonly string[], cwd: string, input?: RunInput): Promise<number>;
  /**
   * Мутация, чей вывод и идёт оператору по ходу, и собирается: оба
   * потока — в stderr процесса (stdout команды пуст), итог — значением.
   */
  watch(argv: readonly string[], cwd: string): Promise<ProcessOutcome>;
}

/** Часы: единственное, что нужно команде от времени, — дождаться срока. */
export interface Clock {
  /** Разрешается по истечении `ms` или раньше — по `signal`. */
  delay(ms: number, signal: AbortSignal): Promise<void>;
}

/** Настоящие часы. */
export const systemClock: Clock = {
  delay: (ms, signal) =>
    new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(id);
          resolve();
        },
        { once: true },
      );
    }),
};

/**
 * Настоящий docker. stdout мутаций — в терминал, как и было: docker
 * пишет туда ход сборки и подъёма.
 */
export const systemDocker: Docker = {
  async probe(argv, cwd, signal) {
    const [bin, ...rest] = argv;
    const output = await runProgram(bin, {
      args: rest,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    });
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  },
  async run(argv, cwd, input = {}) {
    const [bin, ...rest] = argv;
    const child = await startProgram(bin, {
      args: rest,
      cwd,
      env: input.env,
      stdin: input.stdin === undefined ? "null" : "piped",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (input.stdin !== undefined) await feed(child.stdin, input.stdin);
    return (await child.status).code;
  },
  async watch(argv, cwd) {
    const [bin, ...rest] = argv;
    const child = await startProgram(bin, {
      args: rest,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const [stdout, stderr] = await Promise.all([
      echoed(child.stdout),
      echoed(child.stderr),
    ]);
    const status = await child.status;
    return { code: status.code, stdout, stderr };
  },
};

/**
 * Текст в stdin процесса. Процесс, вышедший не дочитав, — не наш
 * отказ: его код скажет, что случилось, а оборванный канал ничего не
 * добавит.
 */
async function feed(
  stdin: WritableStream<Uint8Array>,
  text: string,
): Promise<void> {
  const writer = stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
  } catch (err) {
    if (!hasErrorCode(err, "EPIPE")) throw err;
  }
}

/** Поток процесса — в stderr по мере прихода; наружу — весь текст. */
async function echoed(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    // writeSync пишет не обязательно всё: дописывается остаток.
    let written = 0;
    while (written < chunk.length) {
      written += writeSync(STDERR, chunk.subarray(written));
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
