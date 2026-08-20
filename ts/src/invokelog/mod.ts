/**
 * Журнал вызовов (`platform/invoke-log.md`): каждое исполнение команды
 * оставляет ровно одну запись — что запускали, вывод, ошибки, код,
 * длительность. Журналируются обе точки входа бинаря: CLI-вызов и вызов
 * тула MCP-сервером.
 *
 * Обвязка пишет только native-исполнение. Запись вызова маршрута
 * `legacy` делает сам Python-подпроцесс — его собственный журнал в тот
 * же файл; вторая запись отсюда была бы дублем (спека, «Разделение
 * моста»).
 *
 * Вывод перехватывается копией на слое вывода команд: дескрипторы 1/2
 * не подменяются, поэтому isatty у команды и её подпроцессов — как при
 * прямом вызове.
 */

import { appendRecord } from "./file.ts";
import { commandLine, toolCommandLine } from "./mask.ts";
import { formatRecord } from "./record.ts";
import { type LogEnv, readSettings } from "./settings.ts";

export type { LogEnv } from "./settings.ts";
// Число архивов ротации читает и команда чтения журнала (`specs/log.md`):
// искать их обеим сторонам надо по одному правилу.
export { DEFAULT_KEEP } from "./settings.ts";

/** Приёмник вывода процесса — то, что журнал оборачивает копией. */
export interface OutputSink {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Что журналируется: вызов CLI либо вызов тула MCP-сервером. */
export type InvokeCommand =
  | { readonly kind: "argv"; readonly argv: readonly string[] }
  | {
    readonly kind: "tool";
    readonly path: readonly string[];
    readonly input: unknown;
  };

/** Пометка команды: пишутся ли в её запись секции out/err и аргументы. */
export interface OutputPolicy {
  readonly logsOutput: boolean;
  /** Пишутся ли аргументы; `false` — они заменяются маской. */
  readonly logsArguments: boolean;
  /**
   * Путь команды: маска сопоставляет с ним argv и оставляет нетронутыми
   * только сегменты пути — не длину префикса, потому что путь в argv не
   * обязан идти сплошным блоком (`mask.ts`, `maskAfterPath`).
   */
  readonly path: readonly string[];
}

/**
 * Незаконченная запись. Ни один её метод не бросает и не меняет исход
 * команды: журнал работает на копии байт вывода (спека, «Инварианты»).
 */
export interface InvokeRecording {
  /**
   * Вызов пошёл маршрутом `native` — только такие журналирует обвязка.
   * Не вызвано ни разу — записи не будет.
   */
  readonly nativeCall: (command: OutputPolicy) => void;
  /** Приёмник вывода, копирующий печатаемое в запись. */
  readonly capture: (output: OutputSink) => OutputSink;
  /** Прямая запись в секции — для точки входа без печати (MCP-сервер). */
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Дописывает запись в файл журнала. */
  readonly finish: (exitCode: number) => Promise<void>;
}

/** Журнал: одна запись на вызов. */
export interface InvokeLog {
  readonly begin: (command: InvokeCommand) => InvokeRecording;
}

/** Зависимости журнала: настройки, тождество процесса и время. */
export interface InvokeLogDeps {
  /** Ключи `MPU_LOG_*` (`platform/env-file.md`): только env-файл. */
  readonly env: LogEnv;
  /** Путь файла журнала по умолчанию; неизвестен — записей нет. */
  readonly defaultFile: string | undefined;
  readonly pid: number;
  readonly cwd: () => string;
  readonly now: () => Date;
}

/** Журнал, который ничего не пишет: точка входа без журналирования. */
export const NO_INVOKE_LOG: InvokeLog = { begin: () => SILENT };

const SILENT: InvokeRecording = {
  nativeCall: () => {},
  capture: (output) => output,
  out: () => {},
  err: () => {},
  finish: () => Promise.resolve(),
};

/**
 * Собирает журнал. Настройки читаются в момент завершения записи и
 * только для журналируемого вызова: справке и completion незачем
 * трогать env-файл ради журнала, которого у них не будет.
 */
export function makeInvokeLog(deps: InvokeLogDeps): InvokeLog {
  // Время последней начатой записи: два вызова тула в одну миллисекунду
  // обязаны получить разные run_id (спека, «Граничные случаи»), а он
  // выводится из времени и pid — у долгоживущего сервера pid один.
  let lastStamp = 0;
  return {
    begin: (command) => {
      const started = deps.now().getTime();
      const stamp = new Date(Math.max(started, lastStamp + 1));
      lastStamp = stamp.getTime();
      return recording(deps, command, stamp, started);
    },
  };
}

function recording(
  deps: InvokeLogDeps,
  command: InvokeCommand,
  stamp: Date,
  startedMs: number,
): InvokeRecording {
  const out: string[] = [];
  const err: string[] = [];
  let policy: OutputPolicy | undefined;
  return {
    nativeCall: (marked) => {
      policy = marked;
    },
    capture: (output) => ({
      // Сначала пользователю, потом в копию: журнал не может исказить
      // или задержать то, что видно на экране (спека, «Инварианты»).
      // Копия копится только у помеченного вызова: у непомеченного
      // записи не будет, а процесс бывает долгим — `mpu mcp` живёт до
      // остановки сервера, и его вывод рос бы в памяти без конца.
      stdout: (text) => {
        output.stdout(text);
        if (policy !== undefined) out.push(text);
      },
      stderr: (text) => {
        output.stderr(text);
        if (policy !== undefined) err.push(text);
      },
    }),
    out: (text) => {
      if (policy !== undefined) out.push(text);
    },
    err: (text) => {
      if (policy !== undefined) err.push(text);
    },
    finish: async (exitCode) => {
      if (policy === undefined) return;
      const logsOutput = policy.logsOutput;
      try {
        const settings = readSettings(deps.env, deps.defaultFile);
        if (!settings.enabled || settings.file === undefined) return;
        await appendRecord(
          settings.file,
          formatRecord({
            startedAt: stamp,
            offsetMinutes: -stamp.getTimezoneOffset(),
            pid: deps.pid,
            cwd: deps.cwd(),
            commandLine: lineOf(command, policy),
            note: settings.notes.map((note) => `${note}\n`).join(""),
            out: logsOutput ? out.join("") : "",
            err: logsOutput ? err.join("") : "",
            exitCode,
            durationMs: Math.max(0, deps.now().getTime() - startedMs),
            maxOutputBytes: settings.maxOutputBytes,
          }),
          settings,
        );
      } catch {
        // Fail-open: ошибка журнала (права, диск, лок) не меняет ни
        // результат команды, ни её код возврата (спека, «Инварианты»).
        // Сообщить о ней некуда — вывод команды принадлежит команде.
      }
    },
  };
}

function lineOf(command: InvokeCommand, policy: OutputPolicy): string {
  const masked = !policy.logsArguments;
  switch (command.kind) {
    case "argv":
      // Сегменты пути в argv не обязаны идти сплошным префиксом —
      // общий `--json` встаёт между ними (`entrypoint/mod_test.ts`,
      // `xlsx --json alias ls`), поэтому граница ищется сопоставлением
      // с путём, а не длиной (`mask.ts`, `maskAfterPath`).
      return commandLine(
        command.argv,
        masked ? { path: policy.path } : {},
      );
    case "tool":
      return toolCommandLine(command.path, command.input, { masked });
    default: {
      const unknown: never = command;
      throw new TypeError(`неизвестный вид вызова: ${JSON.stringify(unknown)}`);
    }
  }
}
