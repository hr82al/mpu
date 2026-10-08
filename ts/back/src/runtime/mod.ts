/**
 * Реальные зависимости поверх `node:*`: файлы, stdin, токен доступа
 * (0600), кэш-БД, запуск открывателя и запись в потоки процесса. Отделены от
 * main.ts, чтобы всё остальное тестировалось без запуска бинаря, и от
 * команд — чтобы `CommandIo` оставался интерфейсом на стороне
 * потребителя.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import process from "node:process";
import { buffer } from "node:stream/consumers";
import tty from "node:tty";
import {
  type CommandIo,
  DomainError,
  NEVER_STOPPED,
  NO_ONE,
  NotFoundIoError,
  type RemoteOutput,
} from "@mpu/command";
import type { Output } from "../entrypoint/mod.ts";
import {
  configHomeDir,
  envFilePath,
  type EnvFileStore,
  makeEnvFile,
} from "@mpu/command/env";
import { openCacheDb as openStoreDb } from "@mpu/command/store";

/** Дескрипторы потоков процесса. */
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;

const encoder = new TextEncoder();

/** Полная запись: `writeSync` может записать буфер частично. */
function writeAllSync(fd: number, text: string): void {
  writeAllBytesSync(fd, encoder.encode(text));
}

function writeAllBytesSync(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.length) {
    // Через объект модуля, а не именованный импорт: тест подменяет
    // запись на нём, и подмену видят все три рантайма.
    written += fs.writeSync(fd, bytes.subarray(written));
  }
}

/**
 * Ошибка ввода-вывода с кодом `code` (`ENOENT`, `EADDRINUSE`, …): коды у
 * `node:*` под Bun, Node и Deno одинаковы.
 */
export function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

function translateNotFound(err: unknown): never {
  if (hasErrorCode(err, "ENOENT")) {
    throw new NotFoundIoError("file not found", { cause: err });
  }
  throw err;
}

/**
 * Каталог локального состояния CLI (`~/.config/mpu`): кэш-БД с
 * предпочтениями (`platform/config.md`), журнал вызовов, токен
 * доступа MCP-сервера. Без HOME каталога нет.
 *
 * `XDG_CONFIG_HOME` здесь не читается намеренно, а не по недосмотру:
 * кэш-БД и журнал — общие файлы с живой Python-реализацией, и обе
 * обязаны находить их одинаково (`platform/store.md`, «Ввод/вывод»:
 * путь литеральный, переменная НЕ учитывается). Учти её здесь — и у
 * оператора с нестандартной `XDG_CONFIG_HOME` две реализации молча
 * разошлись бы по разным базам. Конфигурация уводится ею и лежит в
 * соседнем каталоге (`defaultCredsDir`); изолировать разом состояние и
 * конфигурацию можно только подменой `HOME`.
 */
export function defaultStateDir(): string | undefined {
  const home = process.env.HOME;
  if (home === undefined || home === "") return undefined;
  return `${home}/.config/mpu`;
}

/**
 * Файл журнала вызовов по умолчанию (`platform/invoke-log.md`): сосед
 * кэш-БД в том же каталоге, общий с Python-реализацией. Без HOME пути
 * нет — журнал молчит; `XDG_CONFIG_HOME` его не уводит по той же
 * причине, что и кэш-БД (`defaultStateDir`).
 */
export function defaultInvokeLogPath(): string | undefined {
  const home = process.env.HOME;
  if (home === undefined || home === "") return undefined;
  return `${home}/.config/mpu/mpu.log`;
}

/** Потоки процесса как приёмник вывода точки входа. */
export function makeDenoOutput(): Output {
  return {
    stdout: (text) => writeAllSync(STDOUT, text),
    stderr: (text) => writeAllSync(STDERR, text),
  };
}

/**
 * Каталог конфигурации (`XDG_CONFIG_HOME`, дефолт `~/.config/mpu`):
 * env-файл с кредами и выведенный из них токен-кэш sl-back. Правило
 * одно на оба файла и живёт в одном месте — `configHomeDir`
 * (`@mpu/command/env`).
 */
export function defaultCredsDir(): string | undefined {
  return configHomeDir((name) => process.env[name]);
}

/**
 * Файл токен-кэша sl-back (`platform/slback-http.md`): сосед env-файла,
 * а не кэш-БД. Токен выведен из кред этого самого файла, поэтому уводит
 * его та же переменная, что и креды (`XDG_CONFIG_HOME`): иначе подменный
 * env-файл с чужим сервером переиспользовал бы токен основного. Имя
 * файла дословно от Python-реализации — файл общий и с ней.
 */
export function tokenCachePath(
  credsDir: string | undefined,
): string | undefined {
  return credsDir === undefined ? undefined : `${credsDir}/.api-token.json`;
}

/**
 * Файл токена доступа MCP-сервера: сосед кэш-БД в том же каталоге, но
 * не ключ предпочтений (`platform/mcp-server.md`).
 */
export function accessTokenPath(
  stateDir: string | undefined,
): string | undefined {
  return stateDir === undefined ? undefined : `${stateDir}/token`;
}

/** Shell, которые умеет дополнять CLI (`platform/registry.md`). */
const KNOWN_SHELLS = ["bash", "zsh"];

/**
 * Ближайший известный shell в дереве процессов-предков. Переменная
 * `SHELL` не участвует намеренно: она называет login-shell
 * пользователя, а нужен тот, из которого запущен процесс (спека).
 *
 * Дерево читается из procfs: у каждого процесса там есть имя и ppid.
 * Нет procfs — shell не определён, и вызывающий просит указать его
 * аргументом.
 */
function detectShell(): string | undefined {
  return shellInAncestors(readProcStatFile, process.ppid);
}

/** Запись `/proc/<pid>/stat`: имя процесса и его родитель. */
export interface ProcStat {
  readonly name: string;
  readonly ppid: number;
}

/**
 * Ближайший известный shell в цепочке предков. Чтение передаётся
 * параметром: сам обход — чистая логика, и проверяется без procfs,
 * которого у чужих процессов в песочнице всё равно нет.
 */
export function shellInAncestors(
  read: (pid: number) => ProcStat | undefined,
  startPid: number,
): string | undefined {
  let pid = startPid;
  // Ограничение на глубину: цепочка предков конечна, но испорченный
  // procfs не должен превращаться в бесконечный цикл.
  for (let depth = 0; depth < 16 && pid > 1; depth++) {
    const stat = read(pid);
    if (stat === undefined) return undefined;
    // Login-shell записан с дефисом («-bash») — это тот же shell.
    const name = stat.name.replace(/^-/, "");
    if (KNOWN_SHELLS.includes(name)) return name;
    pid = stat.ppid;
  }
  return undefined;
}

/**
 * Разбор строки `/proc/<pid>/stat`. Формат: «pid (comm) state ppid …»;
 * имя в скобках может содержать пробелы и сами скобки, поэтому режется
 * по последней закрывающей.
 */
export function parseProcStat(raw: string): ProcStat | undefined {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const rest = raw.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  return {
    name: raw.slice(open + 1, close),
    ppid: Number.isNaN(ppid) ? 1 : ppid,
  };
}

function readProcStatFile(pid: number): ProcStat | undefined {
  try {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    // Нет procfs или процесс исчез — shell не определён; это не сбой.
    return undefined;
  }
}

/**
 * Файл токена по пути: чтение и запись с правами 0600. Тот же приём,
 * что у токена MCP-сервера, для второго файла — агентского токена
 * `mpu-back` (`cli-client.md`, «Канал и токен»).
 */
export function tokenFile(
  path: string,
): Pick<CommandIo, "readAccessToken" | "writeAccessToken"> {
  return {
    readAccessToken: async () => {
      try {
        return (await readFile(path, "utf8")).trim();
      } catch (err) {
        if (hasErrorCode(err, "ENOENT")) return undefined;
        throw err;
      }
    },
    writeAccessToken: (token) => writeSecret(path, `${token}\n`),
  };
}

/** Файл с секретами целиком: чтение и атомарная перезапись с 0600. */
export interface SecretText {
  /** Текст файла; нет файла — пустая строка. */
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/**
 * Файл с секретами по пути: читатель никогда не видит полузаписанный
 * файл (временный сосед и переименование), права — ровно 0600.
 */
export function secretText(path: string): SecretText {
  return {
    read: async () => {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        if (hasErrorCode(err, "ENOENT")) return "";
        throw err;
      }
    },
    write: (text) => writeSecretAtomically(path, text),
  };
}

/** Запись файла с секретом: каталог создаётся, права ровно 0600. */
async function writeSecret(path: string, text: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
  // При существующем файле mode из writeFile не применяется —
  // права выравниваются явно.
  await chmod(path, 0o600);
}

/**
 * То же, но заменой целиком: временный файл-сосед и переименование
 * поверх цели. Кэш токена sl-back общий для всех процессов, и
 * `platform/slback-http.md` держит на этом инвариант — читатель
 * никогда не видит полузаписанный файл. Приём тот же, что у записи
 * env-файла ниже.
 */
async function writeSecretAtomically(
  path: string,
  text: string,
): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temp, text, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    // Уборка временного файла не важнее исходной причины отказа и её
    // не затирает.
    await rm(temp).catch(() => {});
    throw err;
  }
}

/**
 * Доступ к env-файлу на диске (`platform/env-file.md`, раздел
 * «Ввод/вывод»): чтение снапшотом, атомарная запись. Запись идёт через
 * временный файл-сосед в том же каталоге — так читатели никогда не видят
 * файл в промежуточном состоянии, — права 0600 выставляются до
 * переименования поверх цели. Сбой до `rename` убирает временный
 * файл, чтобы он не копился; сбой самой уборки не важнее исходной
 * причины отказа записи и её не затирает.
 */
export function makeEnvFileStore(path: string): EnvFileStore {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return {
    path,
    readSync: () => {
      try {
        return fs.readFileSync(path, "utf8");
      } catch (err) {
        if (hasErrorCode(err, "ENOENT")) return undefined;
        throw err;
      }
    },
    write: async (text) => {
      await mkdir(dir, { recursive: true });
      const tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(tmpPath, text, { mode: 0o600 });
        // Файл заведомо новый (имя несёт UUID) — переиспользованием мода
        // существующего файла дело не в этом: umask процесса режет mode
        // при создании, поэтому права после writeFile выравниваются
        // явным chmod.
        await chmod(tmpPath, 0o600);
        await rename(tmpPath, path);
      } catch (err) {
        try {
          await rm(tmpPath);
        } catch {
          // Файла может не быть, если сбой случился до writeFile —
          // это ожидаемый исход уборки, а не отдельная ошибка.
        }
        throw err;
      }
    },
  };
}

/**
 * Реальные зависимости исполнения команд поверх `node:*`. Каталогов
 * два: `stateDir` — состояние (кэш-БД, токен MCP-сервера), `credsDir`
 * — конфигурация (env-файл, токен-кэш sl-back). Умолчание второго —
 * первый: тест, подставивший один каталог, по-прежнему изолирует всё
 * сразу, а разводит их только точка входа (`main.ts`), где переменные
 * окружения и правда разные.
 */
export function makeDenoIo(
  stateDir: string | undefined,
  credsDir: string | undefined = stateDir,
): CommandIo {
  const tokenPath = accessTokenPath(stateDir);
  const cachePath = tokenCachePath(credsDir);
  const envPath = envFilePath((name) => process.env[name]);
  return {
    env: (name) => process.env[name],
    cwd: () => process.cwd(),
    readFile: async (path) => {
      try {
        return await bytesOf(path);
      } catch (err) {
        translateNotFound(err);
      }
    },
    readRegularFile: async (path) => {
      try {
        // Проверка перед чтением, а не разбор ошибки после: у каталога
        // чтение отвечает своим кодом (`EISDIR`), а вызывающему нужен
        // один ответ «читать нечего» на оба случая.
        if (!(await stat(path)).isFile()) {
          throw new NotFoundIoError(`not a regular file: ${path}`);
        }
        return await bytesOf(path);
      } catch (err) {
        translateNotFound(err);
      }
    },
    readTextFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (err) {
        translateNotFound(err);
      }
    },
    readStdin: async () => new Uint8Array(await buffer(process.stdin)),
    stdinIsTerminal: () => tty.isatty(STDIN),
    stdoutIsTerminal: () => tty.isatty(STDOUT),
    // У процесса CLI остановки не бывает: Ctrl+C приходит сигналом ОС
    // и снимает процесс вместе с его подпроцессами, как у старого
    // `mpu` (`platform/line-cancel.md`).
    signal: NEVER_STOPPED,
    consoleColumns: () => consoleColumns(),
    stderrIsTerminal: () => tty.isatty(STDERR),
    // Заметку журнала подставляет точка входа: у рантайма записи нет
    // (как и с `progress`, `platform/invoke-log.md`).
    note: () => {},
    // Спросить некого: у строки сервера свой порт вопроса — его
    // ставит сама строка (`backend/server.ts`, `linePrompt`), а
    // терминал процесса переехал к клиенту вместе с копированием
    // (`platform/monolith-removal.md`).
    prompt: NO_ONE,
    readAccessToken: async () => {
      if (tokenPath === undefined) return undefined;
      try {
        return (await readFile(tokenPath, "utf8")).trim();
      } catch (err) {
        if (hasErrorCode(err, "ENOENT")) return undefined;
        throw err;
      }
    },
    writeAccessToken: async (token) => {
      if (tokenPath === undefined) {
        // Штатная доменная ошибка (exit 1), не «unexpected».
        throw new DomainError("config store is unavailable (HOME is not set)");
      }
      await writeSecret(tokenPath, `${token}\n`);
    },
    readTokenCache: async () => {
      if (cachePath === undefined) return undefined;
      try {
        return await readFile(cachePath, "utf8");
      } catch {
        // Любая причина — «кэша нет», а не отказ: спека равняет
        // отсутствие файла, нечитаемость и порчу содержимого
        // (`platform/slback-http.md`, «Чтение кэша»). Дальше идёт
        // обычный логин, и команда об этом не узнаёт.
        return undefined;
      }
    },
    writeTokenCache: async (text) => {
      if (cachePath === undefined) {
        throw new DomainError("token cache is unavailable (HOME is not set)");
      }
      await writeSecretAtomically(cachePath, text);
    },
    envFile: makeEnvFile(
      envPath === undefined ? undefined : makeEnvFileStore(envPath),
    ),
    currentShell: () => detectShell(),
    appendFile: async (path, text) => {
      await appendFile(path, text);
    },
    launchOpener,
    openCacheDb: () => {
      if (stateDir === undefined) {
        // Штатная доменная ошибка (exit 1): без HOME негде искать файл,
        // общий с Python-реализацией (`platform/store.md`).
        throw new DomainError("путь к кэш-БД не определён: HOME не задан");
      }
      // Каталог тот же, что у токена и журнала: подставив свой,
      // тест получает изолированное состояние целиком, а не наполовину.
      return openStoreDb(`${stateDir}/mpu.db`);
    },
    progress: (line) => writeAllSync(STDERR, `${line}\n`),
    openRemoteOutput: () => streamingRemoteOutput(),
  };
}

/** Файл байтами — `Uint8Array`, а не его подкласс `Buffer`. */
async function bytesOf(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

/**
 * Открыватель в фоне: `true` — запущен, `false` — открывателя нет,
 * исключение — есть, но не запустился. Ответ нужен сразу, а `spawn`
 * сообщает причину сбоя событием позже: сбой виден по отсутствию pid, а
 * «нет» отличается от «не запустился» по пути — имя с `/` проверяется
 * наличием файла, голое имя без pid в `PATH` не нашлось.
 */
function launchOpener(cmd: string, target: string): boolean {
  const child = spawn(cmd, [target], { stdio: "ignore" });
  // Причина уже учтена ответом ниже; без слушателя событие `error`
  // уронило бы процесс.
  child.on("error", () => {});
  if (child.pid !== undefined) {
    child.unref();
    return true;
  }
  if (!cmd.includes("/") || !fs.existsSync(cmd)) return false;
  // Файл есть, но не запустился: причину (`EACCES`) даёт проверка права.
  try {
    fs.accessSync(cmd, fs.constants.X_OK);
  } catch (err) {
    throw new Error(`opener did not start: ${cmd}`, { cause: err });
  }
  throw new Error(`opener did not start: ${cmd}`);
}

/**
 * Ширина консоли процесса. Консоль спрашивается только когда stdout —
 * терминал: в пайпе и в cron ширины нет, и ограничения вывода тоже.
 */
function consoleColumns(): number | undefined {
  if (!tty.isatty(STDOUT)) return undefined;
  // Терминал исчез между проверкой и запросом — ширины нет, и
  // ограничения тоже.
  return process.stdout.columns;
}

/**
 * Проточный приёмник вывода удалённой команды: байты уходят в потоки
 * процесса сразу, как их прислал транспорт («стримить stdout/stderr» —
 * `platform/exec-transport.md`). Копить нечего: всё уже напечатано.
 */
function streamingRemoteOutput(): RemoteOutput {
  // Запись в потоки процесса синхронна: готовность принять следующий
  // кусок наступает тут же, давление передавать нечем и некому.
  return {
    out: (chunk) => {
      writeAllBytesSync(STDOUT, chunk);
      return Promise.resolve();
    },
    err: (chunk) => {
      writeAllBytesSync(STDERR, chunk);
      return Promise.resolve();
    },
    captured: () => "",
  };
}
