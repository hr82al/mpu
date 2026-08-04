/**
 * Реальные зависимости поверх API Deno: файлы, stdin, конфиг-хранилище
 * (0600), запуск открывателя и запись в потоки процесса. Отделены от
 * main.ts, чтобы всё остальное тестировалось без запуска бинаря, и от
 * команд — чтобы `CommandIo` оставался интерфейсом на стороне
 * потребителя.
 */

import {
  type CommandIo,
  DomainError,
  NotFoundIoError,
} from "../command/mod.ts";
import type { Output } from "../entrypoint/mod.ts";
import { envFilePath, type EnvFileStore, makeEnvFile } from "../env/mod.ts";

/** Достаточная часть Deno.stdout/stderr: синхронная запись. */
interface SyncSink {
  writeSync(data: Uint8Array): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Полная запись: writeSync может записать буфер частично. */
function writeAllSync(stream: SyncSink, text: string): void {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += stream.writeSync(bytes.subarray(written));
  }
}

function translateNotFound(err: unknown): never {
  if (err instanceof Deno.errors.NotFound) {
    throw new NotFoundIoError("file not found", { cause: err });
  }
  throw err;
}

/**
 * Файл локального хранилища конфига CLI (`~/.config/mpu`, контракт —
 * docs/specs/platform/config.md); без HOME хранилища нет.
 */
export function defaultConfigStorePath(): string | undefined {
  const home = Deno.env.get("HOME");
  if (home === undefined || home === "") return undefined;
  return `${home}/.config/mpu/config.json`;
}

/** Потоки процесса как приёмник вывода точки входа. */
export function makeDenoOutput(): Output {
  return {
    stdout: (text) => writeAllSync(Deno.stdout, text),
    stderr: (text) => writeAllSync(Deno.stderr, text),
  };
}

/**
 * Файл токена доступа MCP-сервера: сосед хранилища конфига, но не его
 * ключ (`platform/mcp-server.md`).
 */
export function accessTokenPath(
  storePath: string | undefined,
): string | undefined {
  if (storePath === undefined) return undefined;
  return `${storePath.slice(0, storePath.lastIndexOf("/"))}/token`;
}

/**
 * Проверяет, что по пути есть исполняемый файл. Спека маршрута
 * `legacy` не различает «файла нет» и «не исполняем» — для вызывающего
 * это один исход: подпроцесс не запустился. Проверка до запуска, а не
 * по ошибке спавна: так «не исполняем» видно и там, где право на
 * запуск выдано списком путей.
 */
async function requireExecutable(bin: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(bin);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new NotFoundIoError(`cannot run "${bin}"`, { cause: err });
    }
    throw err;
  }
  // mode отсутствует там, где у файловой системы нет прав POSIX;
  // тогда судить об исполнимости нечем — решает сам запуск.
  if (info.mode !== null && (info.mode & 0o111) === 0) {
    throw new NotFoundIoError(`cannot run "${bin}": not executable`);
  }
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
  return shellInAncestors(readProcStatFile, Deno.ppid);
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
    return parseProcStat(Deno.readTextFileSync(`/proc/${pid}/stat`));
  } catch {
    // Нет procfs или процесс исчез — shell не определён; это не сбой.
    return undefined;
  }
}

/** Запись файла с секретом: каталог создаётся, права ровно 0600. */
async function writeSecret(path: string, text: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, text, { mode: 0o600 });
  // При существующем файле mode из writeTextFile не применяется —
  // права выравниваются явно.
  await Deno.chmod(path, 0o600);
}

/**
 * Доступ к env-файлу на диске (`platform/env-file.md`, раздел
 * «Ввод/вывод»): чтение снапшотом, атомарная запись. Запись идёт через
 * временный файл-сосед в том же каталоге — так читатели никогда не видят
 * файл в промежуточном состоянии, — права 0600 выставляются до
 * переименования поверх цели. Сбой до `Deno.rename` убирает временный
 * файл, чтобы он не копился; сбой самой уборки не важнее исходной
 * причины отказа записи и её не затирает.
 */
export function makeEnvFileStore(path: string): EnvFileStore {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return {
    path,
    readSync: () => {
      try {
        return Deno.readTextFileSync(path);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return undefined;
        throw err;
      }
    },
    write: async (text) => {
      await Deno.mkdir(dir, { recursive: true });
      const tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await Deno.writeTextFile(tmpPath, text, { mode: 0o600 });
        // Файл заведомо новый (имя несёт UUID) — переиспользованием мода
        // существующего файла дело не в этом: umask процесса режет mode
        // при создании, поэтому права после writeTextFile выравниваются
        // явным chmod.
        await Deno.chmod(tmpPath, 0o600);
        await Deno.rename(tmpPath, path);
      } catch (err) {
        try {
          await Deno.remove(tmpPath);
        } catch {
          // Файла может не быть, если сбой случился до writeTextFile —
          // это ожидаемый исход уборки, а не отдельная ошибка.
        }
        throw err;
      }
    },
  };
}

/** Реальные зависимости исполнения команд поверх API Deno. */
export function makeDenoIo(storePath: string | undefined): CommandIo {
  const tokenPath = accessTokenPath(storePath);
  const envPath = envFilePath((name) => Deno.env.get(name));
  return {
    env: (name) => Deno.env.get(name),
    cwd: () => Deno.cwd(),
    readFile: async (path) => {
      try {
        return await Deno.readFile(path);
      } catch (err) {
        translateNotFound(err);
      }
    },
    readTextFile: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch (err) {
        translateNotFound(err);
      }
    },
    readTextStdin: () => new Response(Deno.stdin.readable).text(),
    readConfigStore: async () => {
      if (storePath === undefined) return undefined;
      try {
        return await Deno.readTextFile(storePath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return undefined;
        throw err;
      }
    },
    writeConfigStore: async (text) => {
      if (storePath === undefined) {
        // Штатная доменная ошибка (exit 1), не «unexpected».
        throw new DomainError("config store is unavailable (HOME is not set)");
      }
      await writeSecret(storePath, text);
    },
    readAccessToken: async () => {
      if (tokenPath === undefined) return undefined;
      try {
        return (await Deno.readTextFile(tokenPath)).trim();
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return undefined;
        throw err;
      }
    },
    writeAccessToken: async (token) => {
      if (tokenPath === undefined) {
        throw new DomainError("config store is unavailable (HOME is not set)");
      }
      await writeSecret(tokenPath, `${token}\n`);
    },
    runLegacy: async (bin, args) => {
      await requireExecutable(bin);
      const command = new Deno.Command(bin, {
        args: [...args],
        stdin: "inherit",
        stdout: "piped",
        stderr: "piped",
      });
      // Своего перехвата сбоя спавна здесь нет: обе его причины —
      // «нет файла» и «не исполняем» — отсечены проверкой выше, а
      // гонка (файл удалили между проверкой и запуском) доходит до
      // верхнего обработчика `main.ts`: exit 1 и сообщение без трейса.
      const output = await command.output();
      return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    },
    envFile: makeEnvFile(
      (name) => Deno.env.get(name),
      envPath === undefined ? undefined : makeEnvFileStore(envPath),
    ),
    currentShell: () => detectShell(),
    appendFile: async (path, text) => {
      await Deno.writeTextFile(path, text, { append: true, create: true });
    },
    launchOpener: (cmd, target) => {
      try {
        const child = new Deno.Command(cmd, {
          args: [target],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        child.unref();
        return true;
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return false;
        throw err;
      }
    },
  };
}
