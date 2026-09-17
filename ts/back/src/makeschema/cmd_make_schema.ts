/**
 * Команда `mpu make-schema` (`docs/specs/make-schema.md`): создать
 * схему клиента в локальном стенде.
 *
 * Единственная команда с локальным транспортом: вызов идёт `docker
 * exec` на этой же машине, без Portainer и без ssh. Поэтому она и не
 * входит в семейство обёрток (`platform/portainer.md`) — у него весь
 * ход построен вокруг удалённого контейнера.
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  defineCommand,
  UsageError,
} from "../command/mod.ts";
import { copyToClipboard } from "../clipboard/mod.ts";
import { type RunProcess, spawnProcess } from "../exec/mod.ts";
import {
  type CacheReader,
  type Candidate,
  formatCandidates,
  resolveSelector,
} from "../selector/mod.ts";

const argsSchema = z.object({
  selector: z.string({
    error: "нужен SELECTOR: client_id, spreadsheet_id или заголовок",
  }).describe("клиент: client_id, spreadsheet_id, заголовок таблицы"),
  server: z.string().optional().describe(
    "номер контейнера стенда: sl-N; по умолчанию sl-1",
  ),
  "client-id": z.number().int().positive().optional().describe(
    "client_id; без него берётся из кандидатов селектора",
  ),
  print: z.boolean().default(false).describe(
    "напечатать docker-команду и скопировать её, не выполняя",
  ),
});

const resultSchema = z.object({
  container: z.string().describe("контейнер стенда, где идёт вызов"),
  command: z.string().describe("собранная docker-команда одной строкой"),
  printed: z.string().nullable().describe("напечатанная строка; иначе null"),
  output: z.string().describe("вывод команды, если приёмник копил"),
  exitCode: z.number().int().describe("код docker exec, 1:1"),
});

type MakeSchemaArgs = z.infer<typeof argsSchema>;
type MakeSchemaResult = z.infer<typeof resultSchema>;

/** Срез порта: кэш селектора, env-файл и приёмник вывода. */
export type MakeSchemaIo = Pick<
  CommandIo,
  "envFile" | "openCacheDb" | "openRemoteOutput"
>;

/** Подстановки для тестов: живого docker у них нет. */
export interface MakeSchemaOptions {
  readonly runProcess?: RunProcess;
  readonly copy?: (text: string) => Promise<boolean>;
}

/** Номер контейнера стенда по умолчанию. */
const DEFAULT_SERVER = 1;

/** Аргументы docker-вызова; порядок — контракт `node cli`. */
export function dockerArgs(
  serverNumber: number,
  clientId: number,
): readonly [string, ...string[]] {
  return [
    "exec",
    containerOf(serverNumber),
    "node",
    "cli",
    "service:clientsMigrations",
    "init",
    "--client-id",
    String(clientId),
    // Метод его игнорирует, но передаётся он ради паритета с исходной
    // командой (спека, `preserve`).
    "--server",
    `sl-${serverNumber}`,
  ];
}

/** Имя контейнера стенда; форма собирается в одном месте. */
function containerOf(serverNumber: number): string {
  return `mp-sl-${serverNumber}-cli`;
}

/** Номер стенда: явный флаг либо единица; форма `sl-N` обязательна. */
export function serverNumberOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SERVER;
  const match = /^sl-(\d+)$/.exec(raw.trim());
  if (match === null) {
    throw new UsageError(`bad --server: '${raw}' (expected sl-N)`);
  }
  return Number(match[1]);
}

/**
 * Ход вызова: client_id из селектора либо флага, сборка docker-команды
 * и один из двух режимов — печать либо локальное выполнение.
 */
export async function runMakeSchema(
  args: MakeSchemaArgs,
  io: MakeSchemaIo,
  options: MakeSchemaOptions = {},
): Promise<MakeSchemaResult> {
  const serverNumber = serverNumberOf(args.server);
  const clientId = args["client-id"] ?? resolvedClientId(args, io);
  const argv = dockerArgs(serverNumber, clientId);
  const command = ["docker", ...argv].join(" ");
  const container = containerOf(serverNumber);
  if (args.print) {
    // Недоступность буфера молчалива: строка уже напечатана
    // (`platform/clipboard.md`).
    await (options.copy ?? copyToClipboard)(command);
    return { container, command, printed: command, output: "", exitCode: 0 };
  }
  const output = io.openRemoteOutput();
  const exitCode = await (options.runProcess ?? spawnProcess)(
    "docker",
    argv,
    new Uint8Array(),
    output,
  );
  return {
    container,
    command,
    printed: null,
    output: output.captured(),
    exitCode,
  };
}

/**
 * client_id из кандидатов селектора. Кэш открывается только здесь:
 * с явным `--client-id` он не нужен вовсе.
 */
function resolvedClientId(args: MakeSchemaArgs, io: MakeSchemaIo): number {
  let db: CacheDb | undefined;
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  try {
    const resolved = resolveSelector(
      { cache, env: io.envFile },
      args.selector,
    );
    return Number(pickClientId(resolved.candidates));
  } finally {
    db?.[Symbol.dispose]();
  }
}

/** Единственный client_id кандидатов; иначе отказ со списком. */
function pickClientId(candidates: readonly Candidate[]): string {
  const values = new Set(
    candidates
      .map((candidate) => candidate.clientId)
      .filter((id): id is number => id !== null)
      .map(String),
  );
  if (values.size === 1) return [...values][0];
  const list = formatCandidates(candidates);
  throw new UsageError(
    "cannot resolve --client-id from selector; pass --client-id",
    { details: list === "" ? undefined : list.slice(0, -1) },
  );
}

export const makeSchemaCommand = defineCommand({
  path: ["make-schema"],
  summary: "Создать схему клиента в локальном стенде.",
  usage: "mpu make-schema SELECTOR [--server sl-N] [--client-id N] [-p]",
  help: `По умолчанию команда ВЫПОЛНЯЕТСЯ: запускает на ЭТОЙ машине
\`docker exec mp-sl-<N>-cli node cli service:clientsMigrations init\` и
наследует его код выхода 1:1. Метод идемпотентен: схема
schema_<client_id> создаётся, только если её ещё нет.

Транспорт локальный — ни Portainer, ни ssh здесь нет, и --local у
команды поэтому не бывает: она и так локальная.

-p/--print ничего не выполняет: печатает docker-команду одной строкой и
копирует её в буфер обмена.

SELECTOR — client_id, spreadsheet_id или заголовок таблицы; --client-id
берётся из кандидатов, если он там один, иначе задайте флагом.
--server sl-N выбирает контейнер стенда; без него это mp-sl-1-cli
независимо от того, в какой сервер резолвится селектор.

--server уходит и внутрь вызова, хотя init его игнорирует: так делает
исходная команда, и паритет здесь важнее чистоты.

Exit: код docker exec при выполнении; 0 при печати; 2 — ошибки ввода и
резолва.

Примеры: mpu make-schema 777 -p; mpu make-schema 777 --server sl-2`,
  // Мутирующая: создаёт схему в БД стенда.
  policy: "rw",
  helpWhenBare: true,
  argsSchema,
  forms: { selector: { positional: "one" }, print: { short: "p" } },
  resultSchema,
  run: (args, io: MakeSchemaIo) => runMakeSchema(args, io),
  render: (result: MakeSchemaResult) =>
    result.printed === null ? result.output : `${result.printed}\n`,
  textExitCode: (result) => result.exitCode,
});
