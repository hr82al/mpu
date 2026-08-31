/**
 * Реальные зависимости поверх API Deno: файлы, stdin, токен доступа
 * (0600), кэш-БД, запуск открывателя и запись в потоки процесса. Отделены от
 * main.ts, чтобы всё остальное тестировалось без запуска бинаря, и от
 * команд — чтобы `CommandIo` оставался интерфейсом на стороне
 * потребителя.
 */

import {
  type CommandIo,
  DomainError,
  NotFoundIoError,
  type RemoteOutput,
  type TerminalIo,
} from "../command/mod.ts";
import type { Output } from "../entrypoint/mod.ts";
import {
  configHomeDir,
  envFilePath,
  type EnvFileStore,
  makeEnvFile,
} from "../env/mod.ts";
import { openCacheDb as openStoreDb } from "../store/mod.ts";

/** Достаточная часть Deno.stdout/stderr: синхронная запись. */
interface SyncSink {
  writeSync(data: Uint8Array): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Полная запись: writeSync может записать буфер частично. */
function writeAllSync(stream: SyncSink, text: string): void {
  writeAllBytesSync(stream, encoder.encode(text));
}

function writeAllBytesSync(stream: SyncSink, bytes: Uint8Array): void {
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
  const home = Deno.env.get("HOME");
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
  const home = Deno.env.get("HOME");
  if (home === undefined || home === "") return undefined;
  return `${home}/.config/mpu/mpu.log`;
}

/** Потоки процесса как приёмник вывода точки входа. */
export function makeDenoOutput(): Output {
  return {
    stdout: (text) => writeAllSync(Deno.stdout, text),
    stderr: (text) => writeAllSync(Deno.stderr, text),
  };
}

/**
 * Каталог конфигурации (`XDG_CONFIG_HOME`, дефолт `~/.config/mpu`):
 * env-файл с кредами и выведенный из них токен-кэш sl-back. Правило
 * одно на оба файла и живёт в одном месте — `configHomeDir`
 * (`src/env/mod.ts`).
 */
export function defaultCredsDir(): string | undefined {
  return configHomeDir((name) => Deno.env.get(name));
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
  await Deno.mkdir(dir, { recursive: true });
  const temp = `${path}.${Deno.pid}.tmp`;
  try {
    await Deno.writeTextFile(temp, text, { mode: 0o600 });
    await Deno.chmod(temp, 0o600);
    await Deno.rename(temp, path);
  } catch (err) {
    // Уборка временного файла не важнее исходной причины отказа и её
    // не затирает.
    await Deno.remove(temp).catch(() => {});
    throw err;
  }
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

/**
 * Реальные зависимости исполнения команд поверх API Deno. Каталогов
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
    readRegularFile: async (path) => {
      try {
        // Проверка перед чтением, а не разбор ошибки после: у каталога
        // `Deno.readFile` отвечает своим классом, а вызывающему нужен
        // один ответ «читать нечего» на оба случая.
        if (!(await Deno.stat(path)).isFile) {
          throw new NotFoundIoError(`not a regular file: ${path}`);
        }
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
    readStdin: async () =>
      new Uint8Array(await new Response(Deno.stdin.readable).arrayBuffer()),
    stdinIsTerminal: () => Deno.stdin.isTerminal(),
    stdoutIsTerminal: () => Deno.stdout.isTerminal(),
    stderrIsTerminal: () => Deno.stderr.isTerminal(),
    // Заметку журнала подставляет точка входа: у рантайма записи нет
    // (как и с `progress`, `platform/invoke-log.md`).
    note: () => {},
    openTerminal: openControllingTerminal,
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
        // Штатная доменная ошибка (exit 1), не «unexpected».
        throw new DomainError("config store is unavailable (HOME is not set)");
      }
      await writeSecret(tokenPath, `${token}\n`);
    },
    readTokenCache: async () => {
      if (cachePath === undefined) return undefined;
      try {
        return await Deno.readTextFile(cachePath);
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
    runLegacyInteractive: async (bin, args) => {
      await requireExecutable(bin);
      // Все три потока — `inherit`: шаг 5 `mpu init` отдаёт терминал
      // подпроцессу целиком (интерактивный вход), поэтому здесь нечего
      // собирать и нечего переносить — только дождаться кода возврата.
      const child = new Deno.Command(bin, {
        args: [...args],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      const status = await child.status;
      return status.code;
    },
    envFile: makeEnvFile(
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
    progress: (line) => writeAllSync(Deno.stderr, `${line}\n`),
    openRemoteOutput: () => streamingRemoteOutput(),
  };
}

/**
 * Проточный приёмник вывода удалённой команды: байты уходят в потоки
 * процесса сразу, как их прислал транспорт («стримить stdout/stderr» —
 * `platform/exec-transport.md`). Копить нечего: всё уже напечатано.
 */
function streamingRemoteOutput(): RemoteOutput {
  return {
    out: (chunk) => writeAllBytesSync(Deno.stdout, chunk),
    err: (chunk) => writeAllBytesSync(Deno.stderr, chunk),
    captured: () => "",
  };
}

/**
 * Строка, набранная вслепую: терминал переводится в raw-режим, эхо
 * гасит он сам. Режим возвращается в `finally` — иначе терминал
 * остался бы без эха у вызывающего shell'а, и это чинилось бы уже
 * командой `reset`.
 *
 * Разбор посимвольный, потому что в raw-режиме строк нет: перевод
 * строки заканчивает ввод, `DEL`/`BS` стирают символ, `Ctrl-C` и
 * `Ctrl-D` означают «ответа нет».
 */
async function readSecretFrom(file: Deno.FsFile): Promise<string | undefined> {
  // `cbreak` оставляет ISIG: Ctrl-C прерывает ввод сигналом, как в
  // любом другом приглашении. Без него единственным выходом из вопроса
  // о пароле был бы правильный ответ.
  file.setRaw(true, { cbreak: true });
  try {
    const bytes: number[] = [];
    const chunk = new Uint8Array(1);
    while (true) {
      const read = await file.read(chunk);
      if (read === null) break;
      const byte = chunk[0];
      if (byte === 0x0a || byte === 0x0d) break;
      // Ctrl-C и Ctrl-D: ответа не будет, и это не пустая строка.
      if (byte === 0x03 || byte === 0x04) return undefined;
      if (byte === 0x7f || byte === 0x08) {
        // Стирается символ, а не байт: у кириллицы и эмодзи их
        // несколько, и `pop` одного разорвал бы UTF-8 — пароль молча
        // отличался бы от набранного, а показать это некому.
        while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) {
          bytes.pop();
        }
        bytes.pop();
        continue;
      }
      bytes.push(byte);
    }
    return decoder.decode(Uint8Array.from(bytes));
  } finally {
    file.setRaw(false);
    // Перевод строки за пользователя: его собственный не отобразился.
    // Пишется в stderr, а не в сам терминал: запись в `/dev/tty`
    // требует `--allow-all` (см. `openControllingTerminal`).
    writeAllSync(Deno.stderr, "\n");
  }
}

/**
 * Управляющий терминал процесса: `/dev/tty`, открытый только на
 * чтение — запись в него требует `--allow-all` (замер ниже). Терминала
 * нет (пайп без tty, cron, вызов тула) — открыть не удаётся, и это не
 * ошибка, а ответ `undefined`: решает по нему команда
 * (`docs/specs/confirm.md`).
 *
 * Имя устройства не сообщается: `ttyname` в Deno нет, и выдумывать его
 * по номеру fd — значит печатать в диагностике догадку.
 */
async function openControllingTerminal(): Promise<TerminalIo | undefined> {
  let file: Deno.FsFile;
  try {
    // Только на чтение — и это не экономия права, а единственная
    // работающая форма. Замер 2026-08-31 на Deno 2.9.5 под
    // псевдотерминалом: `{read:true}` открывается при обычных правах,
    // а `{write:true}` и `{read:true,write:true}` требуют
    // `--allow-all` («Requires all access to "/dev/tty"») — при любом
    // списке путей, включая `--allow-read --allow-write` без
    // ограничений. Собранный бинарь `--allow-all` не несёт и нести не
    // должен, поэтому вопрос печатается в stderr: там его видно и в
    // конвейере, где stdout занят данными.
    file = await Deno.open("/dev/tty", { read: true });
  } catch {
    return undefined;
  }
  return {
    name: undefined,
    // Вопрос идёт в stderr: писать в сам терминал нельзя (см. выше), а
    // stderr в интерактивном сеансе — он же и есть. Запись синхронная
    // поверх того же полного writeAll, что и у потоков процесса.
    write: (text) => {
      writeAllSync(Deno.stderr, text);
      return Promise.resolve();
    },
    readLine: () => readLineFrom(file),
    readSecret: () => readSecretFrom(file),
    [Symbol.dispose]: () => file.close(),
  };
}

/**
 * Одна строка ответа. Читается побайтно: терминал отдаёт ввод по
 * нажатию Enter, а забрать из него лишнее нельзя — следующий читатель
 * этого же устройства недосчитался бы своего.
 */
async function readLineFrom(file: Deno.FsFile): Promise<string | undefined> {
  const bytes: number[] = [];
  const chunk = new Uint8Array(1);
  while (true) {
    const read = await file.read(chunk);
    if (read === null) break;
    if (read === 0) continue;
    if (chunk[0] === 0x0a) return decoder.decode(new Uint8Array(bytes));
    bytes.push(chunk[0]);
  }
  return bytes.length === 0 ? undefined : decoder.decode(new Uint8Array(bytes));
}
