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

import { DomainError } from "../command/mod.ts";
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

/**
 * Каталоги временных файлов, в которые собранному бинарю разрешено
 * писать (`deno.jsonc`, задача `build`). Списком, а не готовой
 * строкой: текст отказа обязан перечислять ровно то, что в правах, и
 * совпадение с задачей `build` проверяется тестом — иначе два места
 * разошлись бы молча.
 */
export const DUMP_DIRS: readonly string[] = ["/tmp", "/var/tmp"];

/**
 * Временный файл дампа; имя уникально на вызов. Один на обе команды
 * копирования: у файла есть право сборки, и второе место его создания
 * рано или поздно разошлось бы с первым — как раз то, чем эта ловушка
 * и обошлась (`docs/specs/copy-client.md`, «Известные ловушки»).
 *
 * Отказ прав переводится в доменный: Deno прячет путь за `<TMP>`
 * («Requires write access to <TMP>»), и оператор из такого сообщения не
 * узнаёт ни какой каталог не подошёл, ни что с этим делать.
 */
export function makeDumpFile(prefix: string): string {
  try {
    return Deno.makeTempFileSync({ prefix, suffix: ".dump" });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotCapable)) throw err;
    throw new DomainError(
      "нет права записи в каталог временных файлов: собранный mpu пишет " +
        `дамп в ${DUMP_DIRS.join(" или ")}`,
      {
        // Не `hint`: там ждут готовую команду, а здесь выбор из двух
        // действий (`src/command/errors.ts`, `ErrorDetails`).
        advice: "сбрось TMPDIR либо укажи его на один из этих каталогов",
        cause: err,
      },
    );
  }
}

/** Удаление временного файла; его отсутствие — не отказ. */
export function removeDumpFile(path: string): void {
  try {
    Deno.removeSync(path);
  } catch {
    // Файл мог не создаться вовсе — упавший дамп это штатный исход.
  }
}

/**
 * Запуск `redis-cli` в контейнере: аргументы и то, что уходит ему на
 * вход. Значение через stdin, а не аргументом: строка клиента бывает
 * длинной и содержит что угодно (`copy-client.md`, шаг 5).
 */
export type RunRedis = (
  argv: readonly string[],
  stdin: string,
) => Promise<void>;

/**
 * Настоящий запуск: умолчание шва, а не подстановка вызывающего.
 * Умолчание здесь по той же причине, по которой оно есть у `runTool`:
 * шов без него гаснет молча, и шаг, у которого исполнитель никем не
 * передан, выглядит выполненным. Так и вышло — оба redis-шага не
 * исполнялись в собранном бинаре ни разу (`copy-client.md`, «Известные
 * ловушки окружения»).
 */
export const spawnRedis: RunRedis = async (argv, stdin) => {
  const [bin, ...rest] = argv;
  const child = new Deno.Command(bin, {
    args: rest,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let outcome: Deno.CommandOutput;
  try {
    // Подача и чтение идут одновременно: контейнера может не быть
    // вовсе, тогда процесс закрывает трубу раньше, чем мы дописали, — и
    // запись «до первого чтения» отвергается BrokenPipe **вместо**
    // настоящей причины из stderr («No such container»). Форма та же,
    // что у подпроцесса ssh (`src/exec/ssh.ts`), и по той же причине.
    const [, out] = await Promise.all([
      feed(child.stdin, stdin),
      child.output(),
    ]);
    outcome = out;
  } catch (err) {
    // Незавершённый процесс оставляет неразрешённым свой статус: без
    // явного kill утекли бы и он, и трубы.
    child.kill();
    await child.status;
    throw err;
  }
  if (outcome.success) return;
  const reason = new TextDecoder().decode(outcome.stderr).split("\n")
    .find((line) => line.trim() !== "") ?? `код ${outcome.code}`;
  throw new Error(reason);
};

/**
 * Подача stdin целиком и закрытие трубы. Отказ записи наверх не идёт:
 * он значит, что процесс уже закрыл свой stdin — вышел раньше либо
 * ввод ему не нужен (`FLUSHALL` не читает ничего), — и ответом на
 * вызов остаётся его код выхода, а не жалоба на трубу.
 */
async function feed(
  stream: WritableStream<Uint8Array>,
  text: string,
): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text));
  } catch {
    await writer.close().catch(() => {});
    return;
  }
  await writer.close();
}
