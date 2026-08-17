/**
 * Ход вызова `mpu ssh` (`specs/ssh.md`): разбор входа, источник stdin,
 * таргет, транспорт и код выхода. Печати здесь нет: вывод удалённой
 * команды уходит приёмником io, служебные строки — портом диагностики
 * (`platform/command-contract.md`, инвариант 1).
 */

import { z } from "@zod/zod";
import {
  type CacheDb,
  type CommandIo,
  NotFoundIoError,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import {
  chooseTransport,
  containerLocations,
  containerNamesLike,
  type ExecPlace,
  type HttpCall,
  type OpenChannel,
  runOverPortainer,
  runOverSsh,
  type RunProcess,
  viaOf,
} from "../exec/mod.ts";
import type { CacheReader } from "../selector/mod.ts";
import { placeOf } from "./place.ts";

/** Ключ ssh — без настройки (`platform/exec-transport.md`). */
const KEY_FILE = ".ssh/id_rsa";

/** Порт исполнения глазами команды. */
export type SshIo = Pick<
  CommandIo,
  | "env"
  | "envFile"
  | "openCacheDb"
  | "openRemoteOutput"
  | "progress"
  | "readFile"
  | "readTextStdin"
  | "stdinIsTerminal"
>;

export const argsSchema = z.object({
  selector: z.string().optional().describe(
    "sl-N, dev:N, точное имя контейнера, client_id/spreadsheet/title;" +
      " при --all-containers — первый токен команды",
  ),
  command: z.array(z.string()).default([]).describe(
    "команда для контейнера; неопознанные флаги уходят в неё как есть",
  ),
  via: z.string().optional().describe(
    "транспорт серверного таргета: ssh|portainer",
  ),
  "all-containers": z.string().optional().describe(
    "выполнить во всех контейнерах кэша, чьё имя содержит подстроку",
  ),
  "stdin-text": z.string().optional().describe("stdin команды строкой"),
  "stdin-file": z.string().optional().describe("stdin команды из файла"),
  "stdin-tty": z.boolean().default(false).describe(
    "читать stdin с терминала до Ctrl+D",
  ),
});

export const resultSchema = z.object({
  exitCode: z.number().int().describe("код выхода удалённой команды, 1:1"),
  output: z.string().describe(
    "вывод удалённой команды; в CLI он уже ушёл в потоки и здесь пуст",
  ),
});

/**
 * Подстановки транспорта. У боевого вызова их нет: бэкенды сами берут
 * подпроцесс и сокет, а тест команды подставляет фейки — живого
 * контейнера у него быть не может по построению (спека, «Побочные
 * эффекты»).
 */
export interface SshOptions {
  readonly runProcess?: RunProcess;
  readonly openChannel?: OpenChannel;
  readonly httpCall?: HttpCall;
}

export type SshArgs = z.infer<typeof argsSchema>;
export type SshResult = z.infer<typeof resultSchema>;

/** Код выхода и вывод, если приёмник его копил. */
export async function runSsh(
  args: SshArgs,
  io: SshIo,
  options: SshOptions = {},
): Promise<SshResult> {
  const command = commandOf(args);
  // Пустая команда проверяется раньше всего: голый `mpu ssh` отказывает
  // про команду, а не про селектор (спека, «Граничные случаи»).
  if (command === null) throw new UsageError("пустая команда");

  const stdin = await stdinOf(args, io);
  const output = io.openRemoteOutput();
  // Кэш-БД одна на вызов и закрывается детерминированно: у CLI её
  // закрыл бы конец процесса, а долгоживущий MCP-сервер копил бы
  // открытые файлы по вызову тула.
  let db: CacheDb | undefined;
  const cache: CacheReader = {
    query: (sql, ...params) => (db ??= io.openCacheDb()).query(sql, ...params),
  };
  const attempt: Attempt = {
    io,
    options,
    cache,
    command,
    stdin,
    output,
    via: viaOf(args.via),
  };
  const run = (place: ExecPlace) => execute(place, attempt);

  const filter = args["all-containers"];
  try {
    const exitCode = filter === undefined
      ? await run(placeOf(args.selector ?? "", { cache, env: io.envFile }))
      : await fanOut(filter, attempt, run);
    return { exitCode, output: output.captured() };
  } finally {
    db?.[Symbol.dispose]();
  }
}

/** Всё, что нужно одному прогону; собирается один раз на вызов. */
interface Attempt {
  readonly io: SshIo;
  readonly options: SshOptions;
  readonly cache: CacheReader;
  readonly command: readonly [string, ...string[]];
  readonly stdin: Uint8Array;
  readonly output: RemoteOutput;
  readonly via: ReturnType<typeof viaOf>;
}

function execute(place: ExecPlace, attempt: Attempt): Promise<number> {
  const target = chooseTransport({
    place,
    env: attempt.io.envFile,
    cache: attempt.cache,
    via: attempt.via,
  });
  return target.kind === "ssh"
    ? runOverSsh({
      target,
      command: attempt.command,
      stdin: attempt.stdin,
      keyPath: keyPath(attempt.io),
      output: attempt.output,
      run: attempt.options.runProcess,
    })
    : runOverPortainer({
      target,
      command: attempt.command,
      stdin: attempt.stdin,
      output: attempt.output,
      warn: attempt.io.progress,
      open: attempt.options.openChannel,
      http: attempt.options.httpCall,
    });
}

/**
 * Fan-out по контейнерам кэша: последовательно, в порядке выборки;
 * первый ненулевой код прерывает остальные и становится кодом вызова.
 */
async function fanOut(
  filter: string,
  attempt: Attempt,
  run: (place: ExecPlace) => Promise<number>,
): Promise<number> {
  const { io, cache } = attempt;
  const names = containerNamesLike(cache, filter);
  if (names.length === 0) {
    throw new UsageError(
      `контейнеры с подстрокой '${filter}' не найдены; запусти \`mpu init\``,
    );
  }
  io.progress(`# mpu ssh: containers = [${names.join(", ")}]`);
  for (const name of names) {
    io.progress(`# container=${name}`);
    // Имя пришло из той же выборки, поэтому строка кэша есть; выбор
    // первой из нескольких — та же неоднозначность, что и у точного
    // имени, но прерывать ею весь fan-out незачем.
    const location = containerLocations(cache, name)[0];
    const code = await run({ kind: "container", location });
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * Токены команды. При `--all-containers` выделенного селектора нет:
 * первый позиционный токен разбор всё равно кладёт в него, и здесь он
 * возвращается команде (спека, «CLI-контракт»).
 */
function commandOf(args: SshArgs): readonly [string, ...string[]] | null {
  const tokens =
    args["all-containers"] !== undefined && args.selector !== undefined
      ? [args.selector, ...args.command]
      : args.command;
  const [first, ...rest] = tokens;
  return first === undefined ? null : [first, ...rest];
}

/**
 * stdin вызова. Явные источники взаимоисключимы; проверка идёт после
 * команды и до резолва — подключаться, чтобы отказать по вводу, незачем
 * (спека, «Граничные случаи»).
 */
async function stdinOf(args: SshArgs, io: SshIo): Promise<Uint8Array> {
  const text = args["stdin-text"];
  const file = args["stdin-file"];
  const tty = args["stdin-tty"];
  const explicit = [text !== undefined, file !== undefined, tty]
    .filter(Boolean).length;
  if (explicit > 1) {
    throw new UsageError(
      "--stdin-text / --stdin-file / --stdin-tty взаимоисключающи",
    );
  }
  const encoder = new TextEncoder();
  if (text !== undefined) return encoder.encode(text);
  if (file !== undefined) return await readFile(file, io);
  if (tty) {
    io.progress("mpu ssh: введите stdin для команды, завершите Ctrl+D");
    return encoder.encode(await io.readTextStdin());
  }
  // Без явного источника: пайп читается целиком, терминал не читается
  // вовсе — иначе вызов молча ждал бы ввода.
  return io.stdinIsTerminal()
    ? new Uint8Array()
    : encoder.encode(await io.readTextStdin());
}

async function readFile(path: string, io: SshIo): Promise<Uint8Array> {
  try {
    return await io.readFile(path);
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      throw new UsageError(`stdin-файл не читается: ${path}`, { cause: err });
    }
    throw err;
  }
}

function keyPath(io: SshIo): string {
  const home = io.env("HOME");
  if (home === undefined || home === "") {
    throw new UsageError("путь к ssh-ключу не определён: HOME не задан");
  }
  return `${home}/${KEY_FILE}`;
}
