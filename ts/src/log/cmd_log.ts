/**
 * Команда `mpu log` (`docs/specs/log.md`): чтение журнала вызовов.
 * Запись журнала — не эта команда (`platform/invoke-log.md`), здесь
 * только чтение, отбор и печать записей дословно.
 *
 * Собственный вызов в журнал попадает записью без секций вывода: захват
 * stdout/stderr у команды отключён (`logsOutput: false`), иначе журнал
 * печатал бы сам себя.
 */

import { z } from "@zod/zod";
import {
  type CommandIo,
  defineCommand,
  DomainError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { windowStart } from "../dates/mod.ts";
import { DEFAULT_KEEP } from "../invokelog/mod.ts";
import { type LogRecord, parseRecords } from "./parse.ts";
import { recordOfRun, selectRecords } from "./select.ts";

/** Записей по умолчанию, когда `--tail` не задан (спека). */
const DEFAULT_TAIL = 20;

/** Порт исполнения команды. */
export type LogIo = Pick<
  CommandIo,
  "env" | "envFile" | "readTextFile" | "progress"
>;

const argsSchema = z.object({
  tail: z.number().int().default(DEFAULT_TAIL).describe(
    "сколько последних записей печатать; 0 и меньше — все",
  ),
  failed: z.boolean().default(false).describe(
    "только записи с ненулевым кодом выхода",
  ),
  cmd: z.string().optional().describe(
    "записи, чей вызов начинается с `mpu <префикс>`",
  ),
  since: z.string().optional().describe(
    "не старше момента: <число>{s|m|h|d} назад либо unix-ts",
  ),
  run: z.string().optional().describe("одна запись по идентификатору вызова"),
  file: z.string().optional().describe("читать этот файл вместо журнала"),
});

const resultSchema = z.object({
  /** Тексты отобранных записей в порядке файла, дословно. */
  records: z.array(z.string()),
});

export type LogArgs = z.infer<typeof argsSchema>;
export type LogResult = z.infer<typeof resultSchema>;

/** Подмена часов: `--since` считается от текущего момента. */
export interface LogOptions {
  readonly nowSeconds?: () => number;
}

export const logCommand = defineCommand({
  path: ["log"],
  summary: "Показать записи журнала вызовов mpu.",
  usage:
    "mpu log [-n N] [--failed] [--cmd ПРЕФИКС] [--since КОГДА] [--run ID] [--file ПУТЬ]",
  help: `Печатает записи журнала вызовов дословно, от старых к новым:
шапка, секции вывода, строка \`--- end … ---\` и пустая строка между
записями. Своего форматирования и машинных режимов нет — журнал и так
текст.

Без аргументов печатаются последние 20 записей. -n/--tail меняет число;
0 и меньше снимают ограничение и печатают все.

Отборы применяются в таком порядке: сначала --failed (ненулевой код),
--cmd (вызов начинается с \`mpu <префикс>\`; границы токена не
проверяются, поэтому --cmd sql берёт и sql-ro) и --since, и только
потом хвост --tail. То есть --tail 20 --failed — это двадцать последних
УПАВШИХ.

--since принимает <число>{s|m|h|d} (назад от сейчас) либо голое целое
как unix-время; граница включительная. --run ID печатает ровно одну
запись и обрабатывается первым: ни прочие отборы, ни --tail к нему не
применяются. --file читает указанный файл вместо журнала и его архивов.

Ничего не подошло — это успех: stdout пуст, сообщение уходит в stderr,
код 0.

Exit: 0 — успех, включая пустой результат; 1 — журнал не прочитать или
--run не найден; 2 — ошибки ввода.

Примеры: mpu log; mpu log -n 5 --failed; mpu log --cmd sql --since 2h;
mpu log --run 20260801-120000.000-1003`,
  policy: "ro",
  // Вывод команды — сам журнал; в записи о ней его дублировать незачем
  // (`platform/invoke-log.md`).
  logsOutput: false,
  argsSchema,
  forms: { tail: { short: "n" } },
  resultSchema,
  run: (args, io: LogIo) => runLog(args, io),
  render: (result) => result.records.join(""),
});

/**
 * Прогон команды. Вынесено из объявления ради одной подмены — часов:
 * `--since 2h` иначе не проверить, не подстроив время машины.
 */
export async function runLog(
  args: LogArgs,
  io: LogIo,
  options: LogOptions = {},
): Promise<LogResult> {
  const since = args.since === undefined
    ? undefined
    : sinceOf(args.since, (options.nowSeconds ?? defaultNow)());
  const records = await readAll(args.file, io);

  if (args.run !== undefined) {
    // Первым и в одиночку: ни отборы, ни `--tail` к нему не применяются
    // (спека, «CLI-контракт»).
    const found = recordOfRun(records, args.run);
    if (found === null) {
      throw new DomainError(`запись run=${args.run} не найдена`);
    }
    return { records: [found.text] };
  }

  const selected = selectRecords(records, {
    failed: args.failed,
    cmd: args.cmd,
    since,
    tail: args.tail,
  });
  if (selected.length === 0) {
    // Пустой результат — успех: сообщение диагностическое и уходит в
    // stderr, stdout остаётся пустым (спека, отклонение `fix`).
    io.progress("mpu log: записей не найдено");
  }
  return { records: selected.map((record) => record.text) };
}

/**
 * Записи всех читаемых файлов: архивы от старых к новым, затем сам
 * журнал. `--file` замещает и журнал, и архивы целиком.
 */
async function readAll(
  file: string | undefined,
  io: LogIo,
): Promise<readonly LogRecord[]> {
  const records: LogRecord[] = [];
  for (const path of pathsOf(file, io)) {
    const text = await readOrSkip(path, io);
    if (text !== null) records.push(...parseRecords(text));
  }
  return records;
}

/**
 * Текст файла; файла нет — `null` (он молча пропускается). Прочие
 * ошибки чтения — отказ команды: нечитаемый журнал не то же самое, что
 * пустой (спека, «Граничные случаи»).
 */
async function readOrSkip(path: string, io: LogIo): Promise<string | null> {
  try {
    return await io.readTextFile(path);
  } catch (err) {
    if (err instanceof NotFoundIoError) return null;
    const reason = err instanceof Error ? err.message : String(err);
    throw new DomainError(`не прочитать ${path}: ${reason}`);
  }
}

/**
 * Файлы в порядке чтения. Архивы ротации нумеруются с хвоста, поэтому
 * старший номер — самый старый (`platform/invoke-log.md`).
 */
function pathsOf(file: string | undefined, io: LogIo): readonly string[] {
  if (file !== undefined) return [file];
  const journal = journalPath(io);
  if (journal === undefined) return [];
  const keep = keepOf(io);
  const archives: string[] = [];
  for (let index = keep; index >= 1; index--) {
    archives.push(`${journal}.${index}`);
  }
  return [...archives, journal];
}

/** Путь журнала: ключ env-файла, иначе дефолт от домашнего каталога. */
function journalPath(io: LogIo): string | undefined {
  const configured = io.envFile.get("MPU_LOG_FILE");
  if (configured !== undefined && configured !== "") return configured;
  const home = io.env("HOME");
  return home === undefined || home === ""
    ? undefined
    : `${home}/.config/mpu/mpu.log`;
}

/** Сколько архивов искать: тот же ключ, что у ротации. */
function keepOf(io: LogIo): number {
  const raw = io.envFile.get("MPU_LOG_KEEP");
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_KEEP;
}

/**
 * Граница `--since`: разбор общий (`../dates/mod.ts`), а текст отказа —
 * этой команды: он назван её спекой дословно.
 */
export function sinceOf(raw: string, nowSeconds: number): number {
  const parsed = windowStart(raw, nowSeconds);
  if (parsed === null) {
    throw new UsageError(
      `--since: ожидается <число>{s|m|h|d} или unix-ts, получено '${raw}'`,
    );
  }
  return parsed;
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}
