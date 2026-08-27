/**
 * Запуск `pg_dump` и `pg_restore` (`copy-client.md`, шаг 1).
 *
 * Пароль уходит переменной окружения `PGPASSWORD`, а не аргументом:
 * argv виден в `ps` любому пользователю машины, и печатается он же —
 * командой, перед запуском.
 *
 * Вывод инструмента стримится оператору живьём, а последняя строка,
 * похожая на ошибку, запоминается. Это не украшение: `pg_restore`
 * новее сервера-приёмника завершает полностью успешное восстановление
 * кодом 1 (замер 2026-08-28: дамп несёт `SET transaction_timeout`,
 * которого PostgreSQL 16 не знает). Код остаётся отказом — разбирать
 * чужие ошибки по тексту команда не должна, — но оператор обязан
 * увидеть, на чём именно споткнулся инструмент, иначе он не поймёт,
 * что данные на месте (`copy-client.md`, «Известные ловушки»).
 */

import type { PgTarget } from "../sql/mod.ts";

/** Итог запуска инструмента. */
export interface ToolOutcome {
  readonly code: number;
  /** Последняя строка вывода, похожая на ошибку; иначе пустая. */
  readonly lastError: string;
  readonly seconds: number;
}

/**
 * Запуск инструмента с окружением и построчным выводом. Порт узкий и
 * свой: общий `RunProcess` не принимает ни переменных окружения, ни
 * построчного приёмника, а нужны оба.
 */
export type RunTool = (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  onLine: (line: string) => void,
) => Promise<{ code: number }>;

/** Строки `pg_dump`/`pg_restore`, по которым видно ошибку. */
const ERROR_LINE = /(^|\s)(error|ошибка|fatal|errors ignored)/i;

/** Аргументы подключения, общие у обоих инструментов. */
function connectionArgs(target: PgTarget): readonly string[] {
  return [
    "-h",
    target.host,
    "-p",
    String(target.port),
    "-U",
    target.username,
    "-d",
    target.database,
  ];
}

/** Argv дампа схемы клиента в файл. */
export function dumpSchemaArgs(
  source: PgTarget,
  schema: string,
  file: string,
): readonly [string, ...string[]] {
  return [
    "pg_dump",
    ...connectionArgs(source),
    "-Fc",
    "--verbose",
    "-n",
    schema,
    // Владельцы и права не переносятся намеренно: на стенде ролей
    // прода нет, и без этих флагов восстановление падало бы на каждом
    // `ALTER … OWNER TO` (`copy-client.md`, шаг 1).
    "--no-owner",
    "--no-privileges",
    "-f",
    file,
  ] as [string, ...string[]];
}

/** Argv восстановления дампа в локальный приёмник. */
export function restoreArgs(
  target: PgTarget,
  file: string,
): readonly [string, ...string[]] {
  return [
    "pg_restore",
    ...connectionArgs(target),
    "--verbose",
    "--no-owner",
    "--no-privileges",
    file,
  ] as [string, ...string[]];
}

/** Argv дампа целой БД (режим полной БД `copy-dev`). */
export function dumpDatabaseArgs(
  source: PgTarget,
  file: string,
): readonly [string, ...string[]] {
  return [
    "pg_dump",
    ...connectionArgs(source),
    "-Fc",
    "--verbose",
    "--no-owner",
    "--no-acl",
    "-f",
    file,
  ] as [string, ...string[]];
}

/** Argv восстановления целой БД: существующие объекты сносятся. */
export function restoreDatabaseArgs(
  target: PgTarget,
  file: string,
): readonly [string, ...string[]] {
  return [
    "pg_restore",
    ...connectionArgs(target),
    "--verbose",
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    file,
  ] as [string, ...string[]];
}

/** Период heartbeat-строки, пока инструмент молчит (спека). */
export const HEARTBEAT_MS = 10_000;

/**
 * Запуск инструмента: пароль окружением, вывод — оператору, раз в
 * десять секунд — строка «идёт столько-то».
 *
 * Heartbeat не украшение: дамп схемы в сотни таблиц идёт минутами, и
 * без него оператор видит молчащий терминал и не знает, работает ли
 * команда (`copy-client.md`, «Ввод/вывод»).
 */
export async function runTool(
  run: RunTool,
  argv: readonly [string, ...string[]],
  target: PgTarget,
  onLine: (line: string) => void,
  nowMs: () => number,
  heartbeat?: (seconds: number) => void,
): Promise<ToolOutcome> {
  const startedMs = nowMs();
  let lastError = "";
  const timer = heartbeat === undefined ? undefined : setInterval(() => {
    heartbeat(Math.round((nowMs() - startedMs) / 1000));
  }, HEARTBEAT_MS);
  try {
    const outcome = await run(argv, { PGPASSWORD: target.password }, (line) => {
      if (ERROR_LINE.test(line)) lastError = line.trim();
      onLine(line);
    });
    return {
      code: outcome.code,
      lastError,
      seconds: Math.round((nowMs() - startedMs) / 1000),
    };
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

/**
 * Текст отказа инструмента. Последняя ошибка входит в него всегда,
 * когда она была: без неё «failed (exit 1)» не отличить от «данные не
 * скопировались» — а у нас именно этот случай штатно возникает на
 * новой версии `pg_restore`.
 */
export function toolFailure(
  tool: string,
  what: string,
  outcome: ToolOutcome,
): string {
  const head = `${tool} ${what} failed (exit ${outcome.code}, ` +
    `${outcome.seconds}s)`;
  return outcome.lastError === ""
    ? head
    : `${head}; последняя ошибка: ${outcome.lastError}`;
}

/**
 * Настоящий запуск инструмента: вывод построчно оператору, код —
 * наружу. Один на оба потока и на обе команды семейства: копия этой
 * функции в каждой команде разъехалась бы ровно там, где важна
 * одинаковость — в разборе строк вывода.
 */
export const spawnTool: RunTool = async (argv, env, onLine) => {
  const [bin, ...rest] = argv;
  const child = new Deno.Command(bin, {
    args: rest,
    env: { ...env },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    let tail = "";
    for await (const chunk of stream) {
      tail += decoder.decode(chunk, { stream: true });
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
    if (tail !== "") onLine(tail);
  };
  await Promise.all([pump(child.stdout), pump(child.stderr)]);
  return { code: (await child.status).code };
};
