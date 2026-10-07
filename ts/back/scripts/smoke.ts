/**
 * `bun run smoke` — проверка собранных программ на том, чего не видят
 * тесты: тесты идут по исходникам, а пользователь запускает бинари
 * `bun build --compile` (`platform/node-runtime.md`, [S.11]). Состав
 * бинаря (воркер разбора, wasm Telegram, ленивые модули), подпроцессы,
 * файлы состояния и форма вывода видны только запуску самой программы.
 *
 * Семь программ собираются скриптами `compile:*` (`package.json`) во
 * временный каталог внутри `.tmp` репозитория; он же служит им HOME, так
 * что всё, что они пишут в домашний каталог, остаётся во временном.
 * Активная установка (`~/.local/bin/mpu`) и настоящие rc-файлы не
 * трогаются.
 *
 * Проверки идут с `clearEnv`: у бинаря есть ровно те переменные, что
 * заданы явно, — иначе «прочитал окружение» не отличить от «унаследовал
 * его от нас».
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync, rmSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { VERSION } from "../src/version.ts";
import { GRAMMAR } from "../src/messages/mod.ts";
import { HEADERS_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from "../src/http/mod.ts";
import { WARMUP_BUDGET_MS } from "../src/kaiten/mod.ts";
import { envFilePath, makeEnvFile } from "../src/env/mod.ts";
import { ALLOW, RuleBook, RulePath } from "../src/policy/mod.ts";
import { policyFile } from "../src/line/mod.ts";
import { Image, imageFile, ImageMethod } from "../src/image/mod.ts";
import { makeEnvFileStore } from "../src/runtime/mod.ts";
import { denoSession } from "../src/sql/mod.ts";
import { hasErrorCode } from "../src/oserror/mod.ts";
import {
  type ProgramOutput,
  runProgram,
  startProgram,
} from "../src/subprocess/mod.ts";
import { listenLoopback, serveFetch } from "../src/testing/http.ts";
import {
  compareColumns,
  schemaCheckPlan,
  schemaGoldens,
  skipReason,
} from "../src/api/schema_golden.ts";

const decoder = new TextDecoder();

/**
 * Проверка неисполнима в этом окружении. Не «зелёная»: пропуск
 * печатается отдельным словом и считается в итоговой строке — иначе
 * непроверенное выглядело бы проверенным.
 */
class Skipped extends Error {
  override name = "Skipped";
}

/**
 * Предмет прогона: пара собранных программ, которыми человек и
 * пользуется, — сервер строк и клиент, — и два каталога, которыми им
 * подменяют окружение: `home` — состояние (`HOME`), `configHome` —
 * конфигурация (`XDG_CONFIG_HOME`).
 */
interface Subject {
  /** `mpu-back`: исполняет строки. */
  readonly back: string;
  /** `mpu`: тонкий клиент, которым строка подаётся. */
  readonly cli: string;
  readonly home: string;
  readonly configHome: string;
  /** `mpu-task`: оркестратор ролей (`task-orchestrator.md`). */
  readonly task: string;
  /** `XDG_RUNTIME_DIR` оркестратора: каталог его первых сообщений. */
  readonly runtimeDir: string;
}

/** Поднятый сервер строк: адрес и остановка. */
interface Serving extends AsyncDisposable {
  readonly url: string;
}

/**
 * Поднимает сервер строк на порту от ОС и ждёт строку, которой он
 * сообщает адрес (`platform/back-rpc.md`). Адрес берётся из неё, а не
 * задаётся заранее: занятый порт иначе выглядел бы как молчащий
 * сервер.
 *
 * @param subject пара программ прогона
 * @param env окружение сервера сверх `HOME`
 */
async function serve(
  subject: Subject,
  env: Readonly<Record<string, string>> = {},
): Promise<Serving> {
  const child = await startProgram(subject.back, {
    args: ["--port", "0"],
    env: { HOME: subject.home, ...env },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const reader = child.stdout.getReader();
  const stop = async () => {
    // Мёртвый сервер сигнал не получает и не бросает.
    child.kill("SIGTERM");
    await child.status;
    await reader.cancel();
    await child.stderr.cancel();
  };
  let said = "";
  let found: RegExpMatchArray | null = null;
  while (found === null) {
    const next = await reader.read();
    if (next.done) {
      // Убрать за собой обязан и этот путь: иначе процесс и оба пайпа
      // остаются висеть, а прогон сообщает лишь про адрес.
      await stop();
      throw new Error(`mpu-back не сообщил адрес: ${said.trim()}`);
    }
    said += decoder.decode(next.value);
    found = said.match(/http:\/\/\S+/);
  }
  return { url: found[0], [Symbol.asyncDispose]: stop };
}

/** Программа tmux ядра: путь — как в коде (`claudehook`). */
const TMUX_BIN = "/usr/bin/tmux";

/**
 * tmux прогона на сокете `socket`: удался ли вызов и что он сказал —
 * stdout при успехе, первая строка stderr или причина запуска иначе.
 */
async function tmuxAt(
  socket: string,
  args: readonly string[],
): Promise<{ readonly success: boolean; readonly said: string }> {
  let output: ProgramOutput;
  try {
    output = await runProgram(TMUX_BIN, {
      args: ["-S", socket, ...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) throw err;
    return { success: false, said: reasonLine(err) };
  }
  const said = decoder.decode(output.success ? output.stdout : output.stderr);
  return { success: output.success, said: said.trim().split("\n")[0] };
}

/**
 * Строка хука `PermissionRequest` через клиента с окружением `env`:
 * payload права на stdin, транскрипта нет.
 */
async function hookCall(
  subject: Subject,
  url: string,
  env: Readonly<Record<string, string>>,
): Promise<Outcome> {
  const child = await startProgram(subject.cli, {
    args: ["claude-hook", "permission-request"],
    env: { HOME: subject.home, MPU_BACK_URL: url, ...env },
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "true" },
        transcript_path: `${subject.home}/нет-транскрипта.jsonl`,
        cwd: subject.home,
      }),
    ),
  );
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

/** Результат запуска бинаря. */
interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Строка через клиента — тем же путём, которым ходит человек: под
 * каждую поднимается свой сервер. Свой, а не общий: сервер читает
 * env-файл и кэш-БД при старте, а проверки эти файлы по ходу и меняют
 * — общий сервер видел бы состояние, которого уже нет.
 *
 * @param subject пара программ прогона
 * @param args слова строки
 * @param env окружение сервера сверх `HOME`
 * @param cwd каталог, из которого человек зовёт клиента: строка несёт
 *   его серверу (`platform/line-concurrency.md`), и команда, ищущая
 *   рабочую область по предкам, видит именно его
 */
async function run(
  subject: Subject,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  cwd?: string,
): Promise<Outcome> {
  await using server = await serve(subject, env);
  return await ask(subject, server.url, args, cwd);
}

/** Один вызов клиента к названному серверу. */
async function ask(
  subject: Subject,
  url: string,
  args: readonly string[],
  cwd?: string,
): Promise<Outcome> {
  const output = await runProgram(subject.cli, {
    args: [...args],
    // `PATH` клиенту не даётся намеренно: программы копирования
    // названы у него абсолютными путями, и старт без `PATH`
    // — проверяемое свойство, а не удобство прогона
    // (`cli-client.md`, «Права клиента и `PATH`»).
    env: { HOME: subject.home, MPU_BACK_URL: url },
    clearEnv: true,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

/**
 * Строки прогона, которым нужно записанное разрешение: у мутирующей
 * команды умолчание — «спросить», а спросить в прогоне некого
 * (`platform/policy.md`). Записывается только то, что прогон
 * действительно зовёт: машина прогона выглядит как машина, где человек
 * однажды разрешил именно эти строки, а не всё подряд.
 */
const ALLOWED: readonly string[] = [
  "config",
  "copy-dev",
  "d2-miro",
  "image sync",
  "init",
  "mp-clone",
  "ssh",
  "telegram send",
  "update",
];

/**
 * Записывает разрешение для строк прогона. Умолчание команды правилом
 * не является: в книге лежит только решённое человеком, и корневое
 * правило умолчания не перебивает — путь называется целиком.
 *
 * Зовётся до старта серверов: пока сервер работает, запись в книгу со
 * стороны до него не доходит (замер 2026-09-22).
 *
 * @param home каталог состояния прогона
 */
function allowLines(home: string): void {
  // Каталог состояния — тот же, что у серверов прогона:
  // `$HOME/.config/mpu` (`defaultStateDir`), а не сам `HOME`.
  const file = policyFile(`${home}/.config/mpu`);
  if (file === undefined) throw new Error("каталога состояния нет");
  using book = RuleBook.open(file, []);
  for (const path of ALLOWED) book.set(RulePath.parse(path), ALLOW);
}

/** `git` в каталоге прогона; упал — прогон красный. */
async function gitIn(dir: string, args: readonly string[]): Promise<void> {
  const output = await runProgram("git", {
    args: ["-C", dir, ...args],
    stdout: "null",
    stderr: "piped",
  });
  if (!output.success) {
    throw new Error(
      `git ${args[0]}: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
}

/**
 * Метод образа прогона — прямой записью в `image.db` каталога состояния:
 * строка `define:` спросила бы человека, а спросить в прогоне некого.
 */
function seedImageMethod(home: string): void {
  using image = Image.at(imageFile(`${home}/.config/mpu`));
  image.define(
    new ImageMethod({
      receiver: ["kiten"],
      name: "probe",
      words: ["do", "kiten", "whoami", "done"],
      purpose: "проба",
      keys: "",
      author: "human",
      time: "2026-09-25T00:00:00.000Z",
    }),
  );
}

/** Отсутствие файла как утверждение: есть — проверка красная. */
async function assertMissing(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return;
    throw err;
  }
  throw new Error(`файл появился там, где его быть не должно: ${path}`);
}

/** Успешный запуск; иначе в сообщение попадает stderr бинаря. */
async function runOk(
  subject: Subject,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Outcome> {
  const outcome = await run(subject, args, env);
  assert.deepStrictEqual(
    outcome.code,
    0,
    `mpu ${args.join(" ")} завершился с ${outcome.code}: ${outcome.stderr}`,
  );
  return outcome;
}

/**
 * Env-файл для прогона `copy-dev`: обязательные ключи источника,
 * указанные на петлю с заведомо закрытым портом. Дальше создания
 * временного файла вызов и не должен уходить — `pg_dump` не находится
 * вовсе, потому что окружение подпроцесса не несёт PATH.
 */
async function writeCopyDevEnv(subject: Subject): Promise<void> {
  const path = `${subject.home}/.config/mpu/.env`;
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(
    path,
    "DEV_WORKSPACES_HOST=127.0.0.1\nDEV_WORKSPACES_PORT=1\n" +
      "DEV_WORKSPACES_USER=smoke\nDEV_WORKSPACES_PASSWORD=smoke\n",
  );
}

/** Убирает env-файл прогона: следующая проверка пишет свой. */
async function removeEnvFile(subject: Subject): Promise<void> {
  await rm(`${subject.home}/.config/mpu/.env`).catch(() => {});
}

/**
 * Пригоден ли `/tmp` для записи в этом окружении. Зонд делает сам
 * smoke, а не бинарь: в песочнице `/tmp` бывает только на чтение, и
 * отказ файловой системы — не дефект программы.
 */
function probeTempDir(): void {
  const path = `/tmp/mpu-smoke-probe-${randomBytes(6).toString("hex")}`;
  try {
    closeSync(openSync(path, "wx"));
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : "";
    throw new Skipped(`/tmp недоступен на запись в этом окружении: ${reason}`);
  }
  try {
    rmSync(path);
  } catch {
    // Зонд убирает за собой best-effort: оставшийся файл ничему не мешает.
  }
}

/**
 * Программы прогона: часть сборки (`compile:<часть>`, `package.json`) →
 * имя программы. Все семь — как у установки (`install.sh`): каждая
 * обязана собраться и ответить на `--version`.
 */
const PROGRAMS: readonly (readonly [part: string, program: string])[] = [
  ["back", "mpu-back"],
  ["worker", "mpu-worker"],
  ["mcp", "mpu-mcp"],
  ["cli", "mpu"],
  ["supervisor", "mpu-supervisor"],
  ["task", "mpu-task"],
  ["complete", "mpu-complete"],
];

/**
 * Собирает программу скриптом `compile:<part>` — тем же, которым собирает
 * её установка: smoke проверяет ровно то, что ставится.
 *
 * @param part часть сборки
 * @param out путь готовой программы
 */
async function compile(part: string, out: string): Promise<void> {
  const compiled = await runProgram("bun", {
    args: ["run", `compile:${part}`],
    env: { MPU_OUT: out },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (!compiled.success) throw new Error(`bun run compile:${part} не собрал`);
}

/** Первый существующий путь из списка; ни одного — `undefined`. */
async function firstExisting(
  paths: readonly string[],
): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await stat(path);
      return path;
    } catch {
      // Нет — пробуем следующий; причина неважна.
    }
  }
  return undefined;
}

/** Строки команд из журнала: по одной на запись. */
function logRecords(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.startsWith("$ mpu "));
}

/** Проверка: имя для отчёта и запуск, падающий с объяснением. */
type Check = readonly [name: string, run: () => Promise<void>];

/**
 * Сессия main-БД по реквизитам оператора. Недостижимая база — пропуск,
 * а не провал: стенд поднимают не всегда, и «не с чем сверять» — другой
 * исход, чем «сверили и разошлось».
 */
async function openMainDb() {
  const path = envFilePath((name) => process.env[name]);
  const envFile = makeEnvFile(
    path === undefined ? undefined : makeEnvFileStore(path),
  );
  const plan = schemaCheckPlan(envFile);
  if (plan.kind === "skip") throw new Skipped(plan.reason);
  try {
    return await denoSession("read-only")(plan.target);
  } catch (err) {
    throw new Skipped(skipReason("unreachable", reasonLine(err)));
  }
}

/** Колонки таблицы по живой `information_schema`; только чтение. */
async function liveColumns(
  session: Awaited<ReturnType<typeof openMainDb>>,
  table: string,
): Promise<readonly string[]> {
  const outcome = await session.query(
    "SELECT column_name FROM information_schema.columns" +
      " WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name",
    ["public", table],
  );
  if (outcome.kind !== "rows") return [];
  return outcome.rows.map((row) => String(row[0]));
}

function reasonLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}

/**
 * Строка сессии в формате прежней реализации (Telethon: версия `1` и
 * base64url от номера DC, IPv4, порта и 256-байтного ключа) с узлом на
 * петле. Ключ нулевой: дальше установки соединения проверка не идёт.
 */
function loopbackSession(port: number): string {
  const bytes = new Uint8Array(1 + 4 + 2 + 256);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 2);
  bytes.set([127, 0, 0, 1], 1);
  view.setUint16(5, port);
  const base64 = btoa(String.fromCharCode(...bytes));
  return `1${base64.replaceAll("+", "-").replaceAll("/", "_")}`;
}

/** Срок, за который бинарь обязан дойти до узла Telegram на петле. */
const NODE_DEADLINE_MS = 15_000;

/**
 * Срок, за который бинарь обязан отказать без соединения с Telegram: предел
 * спеки 20 с и запас на старт программы.
 */
const REFUSAL_DEADLINE_MS = 30_000;

function checks(subject: Subject): readonly Check[] {
  return [
    [
      "version",
      async () => {
        const outcome = await runOk(subject, ["version"]);
        assert.deepStrictEqual(outcome.stdout.trim(), VERSION, "не та версия");
      },
    ],
    // Собранный клиент читает основной токен (`cli-client.md`).
    // Проверяется наблюдаемым следом: основной токен прочитан — значит
    // клиент пришёл дверью человека, и ему доступен её собственный
    // метод; не прочитан — дверь была бы агентской, и метода бы не было.
    [
      "клиент: основной токен читается, дверь человека",
      async () => {
        const outcome = await runOk(subject, ["web"]);
        assert(
          outcome.stdout.startsWith("http://mpu.localhost"),
          `ссылка входа не та: ${JSON.stringify(outcome.stdout)}`,
        );
      },
    ],
    // Клиент живёт без `PATH`: программы копирования названы
    // абсолютными путями (`cli/src/clipboard/mod.ts`, `cli-client.md`,
    // «Права клиента и `PATH`»).
    [
      "клиент стартует без PATH в окружении",
      async () => {
        const outcome = await run(subject, ["version"]);
        assert.deepStrictEqual(outcome.stdout.trim(), VERSION, outcome.stderr);
      },
    ],
    // Временный файл дампа `copy-client`/`copy-dev`
    // (`docs/specs/copy-client.md`, «Известные ловушки»): собранный бинарь
    // заводит его в каталоге временных файлов до первого обращения к PG.
    //
    // Сети здесь нет: адрес источника указан на петлю с заведомо
    // закрытым портом, а `pg_dump` не находится вовсе — окружение
    // подпроцесса не несёт PATH. Дальше создания временного файла
    // вызов и не должен уходить.
    [
      "временный файл дампа ложится в каталог временных файлов",
      async () => {
        // Зонд — до всякой подготовки: бинарь идёт с очищенным
        // окружением, поэтому каталогом временных файлов у него будет
        // `/tmp`, и если он недоступен на запись (так бывает в
        // песочницах), проверять нечем.
        probeTempDir();
        await writeCopyDevEnv(subject);
        try {
          const outcome = await run(subject, ["copy-dev"]);
          const text = `${outcome.stdout}${outcome.stderr}`;
          // Путь дампа виден в строке запуска `pg_dump`, которую команда
          // печатает уже после создания файла.
          assert(
            /\/tmp\/mpu-copy-dev-\w+\.dump/.test(text),
            `в выводе нет пути временного дампа под /tmp: ${JSON.stringify(
              text,
            )}`,
          );
        } finally {
          await removeEnvFile(subject);
        }
      },
    ],
    [
      "MPU_XLSX: ключ env-файла читается, окружение процесса — нет",
      async () => {
        const book = `${subject.home}/book.xlsx`;
        await writeFile(book, "");
        const envPath = `${subject.home}/.config/mpu/.env`;
        await mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });

        await writeFile(envPath, `MPU_XLSX=${book}\n`);
        const fromFile = await runOk(subject, [
          "xlsx",
          "resolve",
          GRAMMAR.close,
          "json",
        ]);
        // Форму результата объявляет схема команды; здесь важен только
        // победивший источник — что ключ env-файла вообще прочитан.
        const fileResult = JSON.parse(fromFile.stdout) as {
          resolved: { source: string } | null;
        };
        assert.deepStrictEqual(
          fileResult.resolved?.source,
          "env",
          "путь пришёл не из env-файла",
        );

        // Обратный случай: та же книга, ключа в env-файле нет, но он
        // экспортирован в окружение процесса — путь не резолвится вовсе
        // (других источников тоже нет). Это и есть smoke-подтверждение
        // того, что окружение процесса больше не читается.
        await rm(envPath);
        // Путь не резолвится — код 2 и с JSON: код отдаёт результат, а не
        // форма (`platform/line-grammar.md` [D.6]).
        const fromProcessEnv = await run(
          subject,
          ["xlsx", "resolve", GRAMMAR.close, "json"],
          {
            MPU_XLSX: book,
          },
        );
        assert.deepStrictEqual(fromProcessEnv.code, 2, fromProcessEnv.stderr);
        const envResult = JSON.parse(fromProcessEnv.stdout) as {
          resolved: { source: string } | null;
        };
        assert.deepStrictEqual(
          envResult.resolved,
          null,
          "путь резолвился из окружения процесса вопреки его исключению из чтения",
        );
      },
    ],
    [
      // Клиент MTProto подгружается лениво (`src/telegram/cmd_send.ts`):
      // тесты этого не проверяют вовсе — там модуль резолвит рантайм, а
      // не бинарь. Здесь вызов доходит до сеанса и падает на фиктивной
      // строке сессии: значит модуль в бинаре есть. Сети проверка не
      // касается — до неё дело не доходит.
      "telegram send: ленивый клиент MTProto есть в бинаре",
      async () => {
        const envPath = `${subject.home}/.config/mpu/.env`;
        await mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });
        await writeFile(
          envPath,
          "TELEGRAM_API_ID=1\nTELEGRAM_API_HASH=проба\n" +
            "TELEGRAM_SESSION=не-строка-сессии\n",
        );
        const outcome = await run(subject, [
          "telegram",
          "send",
          "text:",
          "привет",
          "--chat",
          "me",
        ]);
        await rm(envPath);
        assert.deepStrictEqual(
          outcome.code,
          1,
          `telegram send завершился с ${outcome.code}: ${outcome.stderr}`,
        );
        assert(
          outcome.stderr.startsWith("telegram: не авторизован"),
          `не тот отказ: ${outcome.stderr}`,
        );
      },
    ],
    [
      // Во время работы сеть — только узлы Telegram
      // (`platform/telegram-mtproto.md`, «Прокси»): криптография клиента не
      // скачивает свой wasm. Узел здесь — слушатель на петле, строка сессии
      // называет его адресом DC, и дошедшее до него соединение значит, что
      // инициализация криптографии пройдена. `HTTPS_PROXY` — на закрытый
      // порт петли: скачивание, останься оно, упало бы сразу, а не ушло бы
      // в `jsr.io` мимо проверки. Живых ключей не нужно — дальше
      // соединения проверка не идёт.
      "telegram: криптография без сети, соединение сразу на узел",
      async () => {
        // Узел — слушатель на петле: первое соединение и есть след.
        const node = createTcpServer((conn) => conn.destroy());
        const nodePort = await listenLoopback(node);
        const envPath = `${subject.home}/.config/mpu/.env`;
        await mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });
        await writeFile(
          envPath,
          "TELEGRAM_API_ID=1\nTELEGRAM_API_HASH=проба\n" +
            `TELEGRAM_SESSION=${loopbackSession(nodePort)}\n`,
        );
        // Окружение достаётся серверу: строку исполняет он.
        await using server = await serve(subject, {
          HTTPS_PROXY: "http://127.0.0.1:1",
        });
        const child = await startProgram(subject.cli, {
          args: ["telegram", "ls", "--limit", "1"],
          env: { HOME: subject.home, MPU_BACK_URL: server.url },
          clearEnv: true,
          stdin: "null",
          stdout: "null",
          stderr: "piped",
        });
        const stderr = new Response(child.stderr).text();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const reached = await Promise.race([
            once(node, "connection").then(() => "узел"),
            child.status.then((status) => `завершился с ${status.code}`),
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("срок вышел"), NODE_DEADLINE_MS);
            }),
          ]);
          if (reached !== "узел") {
            if (reached === "срок вышел") child.kill("SIGKILL");
            await child.status;
            throw new Error(
              `до узла Telegram не дошёл (${reached}): ${(
                await stderr
              ).trim()}`,
            );
          }
        } finally {
          clearTimeout(timer);
          // Завершившийся процесс сигнал не получает и не бросает.
          child.kill("SIGKILL");
          await child.status;
          await new Promise<void>((resolve) => node.close(() => resolve()));
          await rm(envPath);
        }
        await stderr;
      },
    ],
    [
      // Соединение с Telegram ограничено 20 с, а логи клиента не пишутся в
      // stdout (`platform/telegram-mtproto.md`, «Прокси»). Прокси — закрытый
      // порт петли: каждое соединение отказывает сразу, и без предела бинарь
      // переподключался бы без конца. Предел проверка ждёт честно, стенным
      // временем — около 20 с. Живых ключей не нужно.
      "telegram: нет соединения за 20 с — отказ текстом спеки, stdout пуст",
      async () => {
        const envPath = `${subject.home}/.config/mpu/.env`;
        await mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });
        await writeFile(
          envPath,
          "TELEGRAM_API_ID=1\nTELEGRAM_API_HASH=проба\n" +
            `TELEGRAM_SESSION=${loopbackSession(1)}\n` +
            "TELEGRAM_PROXY=http://127.0.0.1:1\n",
        );
        await using server = await serve(subject);
        const child = await startProgram(subject.cli, {
          args: ["telegram", "ls", "--limit", "1"],
          env: { HOME: subject.home, MPU_BACK_URL: server.url },
          clearEnv: true,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        });
        const output = child.output();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            output,
            new Promise<"срок вышел">((resolve) => {
              timer = setTimeout(
                () => resolve("срок вышел"),
                REFUSAL_DEADLINE_MS,
              );
            }),
          ]);
          if (outcome === "срок вышел") {
            child.kill("SIGKILL");
            const late = await output;
            throw new Error(
              `за ${REFUSAL_DEADLINE_MS} мс не отказал: ${new TextDecoder()
                .decode(late.stderr)
                .trim()}`,
            );
          }
          const stdout = new TextDecoder().decode(outcome.stdout);
          const stderr = new TextDecoder().decode(outcome.stderr);
          assert(outcome.code === 1, `код ${outcome.code}, ждали 1: ${stderr}`);
          assert(
            stderr.includes("telegram: нет соединения с Telegram за 20 с: "),
            `в stderr нет отказа по пределу: ${stderr}`,
          );
          assert(stdout === "", `stdout не пуст: ${stdout}`);
        } finally {
          clearTimeout(timer);
          await rm(envPath);
        }
      },
    ],
    [
      "init: справка собранного бинаря несёт числа пределов",
      async () => {
        const outcome = await runOk(subject, ["init", "--help"]);
        for (const value of [
          HEADERS_TIMEOUT_MS,
          TOTAL_TIMEOUT_MS,
          WARMUP_BUDGET_MS,
        ]) {
          assert(
            outcome.stdout.includes(String(value)),
            `в справке init нет числа ${value}`,
          );
        }
      },
    ],
    // Бинарь ходит в Portainer и заводит кэш-БД в каталоге состояния.
    // Конфигурация приходит только из env-файла: окружение подпроцесса
    // очищено (`clearEnv`), в нём есть один HOME.
    [
      "init: discovery через фейковый Portainer и кэш-БД в HOME",
      async () => {
        const server = await serveFetch((req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/endpoints") {
            return Response.json([{ Id: 1, Name: "prod", Status: 1 }]);
          }
          return Response.json([
            {
              Id: "c1",
              Names: ["/sl-1-cli"],
              State: "running",
              Image: "img",
            },
          ]);
        });
        try {
          const envPath = `${subject.home}/.config/mpu/.env`;
          await mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
            recursive: true,
          });
          await writeFile(
            envPath,
            "PORTAINER_API_KEY=proba-kluch\n" +
              `PORTAINER_URL=${server.baseUrl}\n`,
          );
          const outcome = await runOk(subject, ["init", "dry"]);
          assert(
            outcome.stdout.includes("sl-1: sl-1-cli [running]"),
            `сводка не та: ${JSON.stringify(outcome.stdout)}`,
          );
          assert(
            outcome.stderr.includes("# bootstrap: схема в"),
            `нет строки шага 1: ${JSON.stringify(outcome.stderr)}`,
          );
          // Файл кэш-БД заведён самим бинарём в каталоге состояния.
          await stat(`${subject.home}/.config/mpu/mpu.db`);
          await rm(envPath);
        } finally {
          await server.stop();
        }
      },
    ],
    // Клиент PostgreSQL в собранном бинаре создаётся и доходит до сети.
    // Живого PG здесь нет и не нужно: адрес заведомо закрыт, ценно то,
    // КАКОЙ ошибкой команда завершается.
    [
      "update: PG-клиент отказывает по сети",
      async () => {
        const envPath = `${subject.home}/.config/mpu/.env`;
        await mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });
        await writeFile(
          envPath,
          "pg_0=127.0.0.1\nPG_PORT=1\n" +
            "PG_MAIN_USER_NAME=proba\nPG_MAIN_USER_PASSWORD=proba\n",
        );
        const outcome = await run(subject, ["update"]);
        assert.deepStrictEqual(outcome.code, 1, `stderr: ${outcome.stderr}`);
        assert(
          outcome.stderr.startsWith("mpu update: main (sl-0) недоступен: "),
          `не тот отказ: ${JSON.stringify(outcome.stderr)}`,
        );
        await rm(envPath);
      },
    ],
    // Граница состояния и конфигурации на собранном бинаре: `HOME`
    // адресует кэш-БД и журнал, `XDG_CONFIG_HOME` — env-файл и
    // выведенный из его кред токен-кэш sl-back. Разводит каталоги одна
    // строка `main.ts`, и проверить её можно только запуском: тесты
    // зовут `makeDenoIo` сами и подстановку из точки входа не видят.
    // Отказ записи кэша глотает сам слой (`slback-http.md`), поэтому
    // наблюдаемое здесь — файл на месте, а не текст.
    [
      "границы каталогов: XDG_CONFIG_HOME уводит токен-кэш, но не кэш-БД",
      async () => {
        const server = await serveFetch(() =>
          Response.json({ accessToken: "проба-токена" }),
        );
        const cachePath = `${subject.configHome}/mpu/.api-token.json`;
        try {
          await mkdir(`${subject.configHome}/mpu`, { recursive: true });
          await writeFile(
            `${subject.configHome}/mpu/.env`,
            `BASE_API_URL=${server.baseUrl}\n` +
              "TOKEN_EMAIL=proba@example.com\nTOKEN_PASSWORD=proba\n",
          );
          const outcome = await runOk(subject, ["api", "get-token"], {
            XDG_CONFIG_HOME: subject.configHome,
          });
          assert.deepStrictEqual(
            outcome.stdout.trim(),
            "проба-токена",
            "не тот токен",
          );
          // Кэш лёг рядом с кредами, из которых токен получен. Права
          // файла проверяет юнит-тест слоя (`src/runtime/mod.test.ts`).
          await stat(cachePath);
          // И не лёг в каталог состояния: иначе токен подменного
          // сервера переиспользовался бы основной конфигурацией.
          await assertMissing(`${subject.home}/.config/mpu/.api-token.json`);
        } finally {
          await server.stop();
          await rm(`${subject.configHome}/mpu`, { recursive: true });
        }
      },
    ],
    // Переехавшая команда на собранном бинаре: `--dry-run` печатает
    // план и не ходит в службу. Доски у smoke нет и быть не должно —
    // живая пара за спецификатором; здесь проверяется, что маршрут
    // `native` у команды рабочий и фикстуры читаются.
    [
      "d2-miro: план --dry-run печатается собранным бинарём",
      async () => {
        const base = `${subject.home}/схема`;
        const from = new URL(
          "../src/d2miro/testdata/d2-miro/",
          import.meta.url,
        );
        // Порядок копирования значим: SVG обязан быть не старше `.d2`,
        // иначе бинарь пойдёт звать `d2`, которого в окружении нет.
        await writeFile(
          `${base}.d2`,
          await readFile(new URL("sample.d2", from), "utf8"),
        );
        await writeFile(
          `${base}.svg`,
          await readFile(new URL("sample.svg", from), "utf8"),
        );
        const outcome = await runOk(subject, [
          "d2-miro",
          "dry",
          "file:",
          `${base}.d2`,
        ]);
        assert(
          outcome.stdout.includes("[dry-run] would create:") &&
            outcome.stdout.includes("shape(can)           mart  kind=cylinder"),
          `не тот план: ${JSON.stringify(outcome.stdout)}`,
        );
        assert(
          outcome.stderr.includes("5 shapes, 5 edges, 1 markdown blocks"),
          `не та строка [info]: ${JSON.stringify(outcome.stderr)}`,
        );
      },
    ],
    // Подпроцесс собранного бинаря (`node:child_process`, `subprocess`):
    // запуск, оба потока и код выхода. Годится не всякий подпроцесс:
    // `d2` в этом окружении нет вовсе, а `ssh` в PATH есть.
    [
      "ssh: подпроцесс запускается и отказывает сам",
      async () => {
        // Ищется там же, где его будет искать бинарь: ему передаётся
        // именно этот PATH, и наличие ssh в PATH самого smoke ничего бы
        // о вызове не говорило.
        const sshBin = await firstExisting(["/usr/bin/ssh", "/bin/ssh"]);
        if (sshBin === undefined) {
          throw new Skipped("`ssh` не найден в /usr/bin и /bin: нечего звать");
        }
        const envDir = `${subject.configHome}/mpu`;
        await mkdir(envDir, { recursive: true });
        await writeFile(
          `${envDir}/.env`,
          // Петля с закрытым портом: ssh обязан запуститься и отказать
          // сам. Наружу вызов не идёт — ни к dev-ноде по умолчанию, ни
          // куда-либо ещё.
          "DEV_NODE_HOST=127.0.0.1\nDEV_NODE_USER=nobody\n",
        );
        try {
          const outcome = await run(
            subject,
            ["ssh", "target:", "dev:1", "cmd:", "echo hi"],
            {
              XDG_CONFIG_HOME: subject.configHome,
              PATH: "/usr/bin:/bin",
            },
          );
          // Утверждение — про то, что говорит сам ssh: строка про
          // недоступный ключ приходит и когда порт закрыт, и когда на
          // машине поднят sshd (тогда отказ будет на аутентификации).
          // Привязка к «connection refused» краснела бы на машине с
          // sshd, ничего не сообщая о запуске.
          assert(
            outcome.stderr.includes("Identity file") &&
              outcome.stderr.includes(".ssh/id_rsa"),
            `подпроцесс ssh не запускался: ${JSON.stringify(outcome.stderr)}`,
          );
          // Код ssh доносится как есть (`exec-transport.md`): 255 — это
          // он, а не наша трактовка; отказ запуска дал бы 1.
          assert.deepStrictEqual(outcome.code, 255, "код ssh не донесён");
        } finally {
          await rm(`${envDir}/.env`);
        }
      },
    ],
    // Канал Claude Code (`claude-channel.md`): собранный клиент держит
    // stdio сессии на `node:*` и регистрируется в ядре по
    // `CLAUDE_CODE_MESSAGING_SOCKET`; значение
    // `CLAUDE_CODE_MESSAGING_TOKEN` не появляется ни в одном выводе.
    [
      "канал: собранный клиент отвечает Claude Code и регистрируется в ядре",
      async () => {
        await using server = await serve(subject);
        const secret = "секрет-канала-7f3a";
        const child = await startProgram(subject.cli, {
          args: ["claude-channel"],
          env: {
            HOME: subject.home,
            MPU_BACK_URL: server.url,
            CLAUDE_CODE_MESSAGING_SOCKET: `${subject.home}/cc-1.sock`,
            CLAUDE_CODE_MESSAGING_TOKEN: secret,
          },
          clearEnv: true,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const stdout = new Response(child.stdout).text();
        const writer = child.stdin.getWriter();
        await writer.write(
          new TextEncoder().encode(
            '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}\n' +
              '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
          ),
        );
        // Регистрация — след в stderr канала; дождаться его, затем EOF.
        const errors = child.stderr.getReader();
        let said = "";
        while (!said.includes("зарегистрирован в ядре")) {
          const next = await errors.read();
          if (next.done) break;
          said += decoder.decode(next.value, { stream: true });
        }
        await writer.close();
        for (
          let next = await errors.read();
          !next.done;
          next = await errors.read()
        ) {
          said += decoder.decode(next.value, { stream: true });
        }
        const status = await child.status;
        const out = await stdout;
        assert.deepStrictEqual(status.code, 0, said);
        assert(said.includes("зарегистрирован в ядре"), said);
        assert(out.includes('"experimental":{"claude/channel":{}}'), out);
        assert(
          !out.includes(secret) && !said.includes(secret),
          "токен в выводе",
        );
      },
    ],
    // Ядро зовёт `/usr/bin/tmux` (`claude-hook-permission-request.md`
    // [D.7]): строка хука `PermissionRequest` подписывает вопрос окном
    // tmux клиента — `tmux -S <сокет из TMUX> display-message`. Сервер
    // tmux прогона отмечает каждый такой вызов хуком
    // `after-display-message`: отметка и есть след запуска tmux собранным
    // `mpu-back`. Клиент несёт `TMUX` и `TMUX_PANE`.
    [
      "tmux: подпись окна вопроса запускает /usr/bin/tmux",
      async () => {
        const socket = `${subject.home}/tmux.sock`;
        const tmux = (...args: string[]) => tmuxAt(socket, args);
        const started = await tmux(
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "w",
          "-n",
          "probe",
          "sleep 600",
        );
        // Сервер tmux не поднялся (нет программы, сокеты запрещены
        // окружением) — проверять нечем; причина — его словами.
        if (!started.success) throw new Skipped(started.said);
        try {
          const pane = (await tmux("list-panes", "-F", "#{pane_id}")).said;
          await tmux(
            "set-hook",
            "-g",
            "after-display-message",
            "set-option -g @shown yes",
          );
          await using server = await serve(subject);
          const outcome = await hookCall(subject, server.url, {
            TMUX: `${socket},1,0`,
            TMUX_PANE: pane,
          });
          assert.deepStrictEqual(
            [outcome.code, outcome.stdout],
            [0, ""],
            outcome.stderr,
          );
          assert.deepStrictEqual(
            (await tmux("show-options", "-gv", "@shown")).said,
            "yes",
            "mpu-back не запускал tmux",
          );
        } finally {
          await tmux("kill-server");
        }
      },
    ],
    // Журнал вызовов: одна запись на вызов и ни одной лишней. Журнал
    // живёт в каталоге состояния, а путь приходит ключом env-файла, не
    // окружением процесса (`platform/invoke-log.md`).
    [
      "журнал вызовов: по записи на вызов",
      async () => {
        const configDir = `${subject.home}/.config/mpu`;
        const logPath = `${configDir}/invoke.log`;
        await mkdir(configDir, { recursive: true });
        await writeFile(`${configDir}/.env`, `MPU_LOG_FILE=${logPath}\n`);
        try {
          await rm(logPath);
        } catch {
          // Файла ещё нет: считаем записи этой проверки, а не прогона.
        }
        try {
          // Пути нет — код 2 (`platform/line-grammar.md` [D.6]); запись
          // журнала от кода не зависит.
          const resolve = await run(subject, [
            "xlsx",
            "resolve",
            GRAMMAR.close,
            "json",
          ]);
          assert.deepStrictEqual(resolve.code, 2, resolve.stderr);
          const afterFirst = await readFile(logPath, "utf8");
          assert.deepStrictEqual(
            logRecords(afterFirst),
            [`$ mpu xlsx resolve ${GRAMMAR.close} json`],
            `не одна запись вызова: ${JSON.stringify(afterFirst)}`,
          );
          // Второй вызов — вторая запись, не больше и не меньше: пока
          // жил маршрут `legacy`, запись о его вызове делал подпроцесс, и
          // обвязка своей не добавляла. Маршрута нет, записи делает
          // только обвязка — считаем, что ровно по одной.
          await runOk(subject, ["config", GRAMMAR.close, "json"]);
          const afterSecond = await readFile(logPath, "utf8");
          assert.deepStrictEqual(
            logRecords(afterSecond),
            [
              `$ mpu xlsx resolve ${GRAMMAR.close} json`,
              `$ mpu config ${GRAMMAR.close} json`,
            ],
            `записи задвоились: ${JSON.stringify(afterSecond)}`,
          );
          assert.deepStrictEqual(
            (await modeOf(logPath)).toString(8),
            "600",
            "права файла журнала не 0600",
          );
        } finally {
          await rm(`${configDir}/.env`);
        }
      },
    ],
    // Проверка, поднимающая клиент PostgreSQL `sql-ro`. Живого
    // PostgreSQL у smoke нет, поэтому адрес заведомо закрытый: важно,
    // что отказ пришёл от драйвера.
    [
      "sql-ro: мета-блок из env-файла и живой PG-клиент",
      async () => {
        const configDir = `${subject.home}/.config/mpu`;
        await mkdir(configDir, { recursive: true });
        await writeFile(
          `${configDir}/.env`,
          "pg_1=127.0.0.1\nPG_PORT=1\nPG_MY_USER_NAME=u\nPG_MY_USER_PASSWORD=p\n",
        );
        try {
          const dry = await runOk(subject, [
            "sql-ro",
            "dry",
            "verbose",
            "target:",
            "sl-1",
            "sql:",
            "SELECT 1",
          ]);
          assert.deepStrictEqual(
            dry.stdout,
            "",
            "у --dry stdout обязан быть пуст",
          );
          assert.deepStrictEqual(
            dry.stderr,
            "server: sl-1\npg_host: 127.0.0.1\npg_port: 1\ndatabase: wb\n" +
              "mode: read-only\nsql:\nSELECT 1\n",
            "мета-блок собран не из env-файла",
          );

          const live = await run(subject, [
            "sql-ro",
            "target:",
            "sl-1",
            "sql:",
            "SELECT 1",
          ]);
          assert.deepStrictEqual(
            live.code,
            1,
            `не отказ БД: ${JSON.stringify(live)}`,
          );
          assert(
            live.stderr.startsWith("db error: "),
            `отказ не от драйвера: ${JSON.stringify(live.stderr)}`,
          );
        } finally {
          await rm(`${configDir}/.env`);
        }
      },
    ],
    // Разбор кода собранным бинарём: `mpu code refs` строит программу
    // проекта компилятором TypeScript, запечённым в бинарь, и зовёт
    // `git` за отметкой дерева. Тесты идут по исходникам; здесь —
    // компилятор и воркер, встроенные в бинарь.
    [
      "code: разбор дерева, отметка и оба раздела собранным бинарём",
      async () => {
        const ws = `${subject.home}/ws`;
        const repo = `${ws}/probe`;
        await mkdir(`${repo}/src`, { recursive: true });
        // Каталог `.git` без содержимого: репозиторием подкаталог делает
        // именно он. Отметка при этом заведомо `вне git`, и по причине,
        // которую надо назвать честно: запуск здесь идёт с `clearEnv`,
        // `PATH` в окружении бинаря нет, и `git` не запускается вовсе.
        // То есть ветка отметки под настоящим git этой проверкой НЕ
        // покрыта — её держат тесты `mark.test.ts` с подставленным
        // источником.
        await mkdir(`${repo}/.git`, { recursive: true });
        await writeFile(`${ws}/.mp-workspace-root`, "");
        await writeFile(
          `${repo}/tsconfig.json`,
          '{"compilerOptions":{"strict":true,"noEmit":true},' +
            '"include":["src/**/*"]}\n',
        );
        await writeFile(
          `${repo}/src/a.ts`,
          "export function addOne(n: number): number {\n  return n + 1;\n}\n",
        );
        await writeFile(
          `${repo}/src/b.ts`,
          "import { addOne } from './a.ts';\n\nexport const two = addOne(1);\n",
        );
        const outcome = await run(
          subject,
          ["code", "refs", "address:", "probe:src/a.ts:1"],
          {},
          repo,
        );
        assert.deepStrictEqual(outcome.code, 0, `stderr: ${outcome.stderr}`);
        assert(
          outcome.stdout.startsWith(
            "probe · вне git · разбор по типам — ответ полон\n",
          ),
          `не та шапка: ${JSON.stringify(outcome.stdout)}`,
        );
        assert(
          outcome.stdout.includes("потребители: 1 файл\n  src/b.ts:1\n"),
          `не тот перечень: ${JSON.stringify(outcome.stdout)}`,
        );
        assert(
          outcome.stdout.includes("не разрешено: 0\n"),
          `нулевой раздел не напечатан: ${JSON.stringify(outcome.stdout)}`,
        );
        // Вторая поверхность семейства идёт тем же путём, но добавляет
        // сканер компилятора: тела нормализуются им.
        const twins = await run(
          subject,
          ["code", "twins", "address:", "probe:src/a.ts:1"],
          {},
          repo,
        );
        assert.deepStrictEqual(twins.code, 0, `stderr: ${twins.stderr}`);
        assert(
          twins.stdout.includes("побайтово: 1\n  src/a.ts:1  addOne\n"),
          `не тот раздел: ${JSON.stringify(twins.stdout)}`,
        );
        assert(
          twins.stdout.includes("похоже: 0\n"),
          `нулевой раздел не напечатан: ${JSON.stringify(twins.stdout)}`,
        );
        // Второй репозиторий заводится ради воркеров: вопрос по всей
        // рабочей области считается по репозиторию в отдельном потоке,
        // и модуль воркера обязан попасть в собранный бинарь. Тесты
        // этого не видят — они идут по исходникам; здесь бинарь либо
        // находит `repo_worker.ts` внутри себя, либо проверка красная.
        // Одного репозитория мало: обход из одного задания считается на
        // месте, и воркер не запускается вовсе.
        const other = `${ws}/probe-two`;
        await mkdir(`${other}/src`, { recursive: true });
        await mkdir(`${other}/.git`, { recursive: true });
        await writeFile(
          `${other}/tsconfig.json`,
          '{"compilerOptions":{"strict":true,"noEmit":true},' +
            '"include":["src/**/*"]}\n',
        );
        await writeFile(
          `${other}/src/c.ts`,
          "export function addOne(n: number): number {\n  return n + 2;\n}\n",
        );
        const name = await run(
          subject,
          ["code", "name", "name:", "addOne"],
          {},
          repo,
        );
        assert.deepStrictEqual(name.code, 0, `stderr: ${name.stderr}`);
        // Разделы идут в порядке перечня репозиториев, а не готовности.
        assert(
          name.stdout.startsWith("probe · вне git · разбор по типам") &&
            name.stdout.includes("\nprobe-two · вне git · разбор по типам"),
          `не тот порядок разделов: ${JSON.stringify(name.stdout)}`,
        );
        assert(
          name.stdout.includes("src/a.ts:1  addOne (n: number): number") &&
            name.stdout.includes("src/c.ts:1  addOne (n: number): number"),
          `оба раздела не ответили: ${JSON.stringify(name.stdout)}`,
        );
      },
    ],
    // Каталог образа (`image-sync.md`): файлы методов пишет ядро строкой
    // `image sync` в `$HOME/mr/mp/mpu/image`; не записав, строка
    // отвечает `сбой`, код 1. Метод посеян записью в `image.db`, правило
    // `image sync` — `allow` (`ALLOWED`): вопроса в прогоне задать
    // некому.
    [
      "каталог образа: файл метода пишется ядром",
      async () => {
        seedImageMethod(subject.home);
        await mkdir(`${subject.home}/mr/mp/mpu`, { recursive: true });
        const outcome = await run(subject, ["image", "sync"]);
        assert.deepStrictEqual(
          [outcome.code, outcome.stdout],
          [0, "новый файл\tkiten probe\nсовпало 0, изменено 1, конфликтов 0\n"],
          `stderr: ${outcome.stderr}`,
        );
        await stat(`${subject.home}/mr/mp/mpu/image/kiten/probe.mpu`);
      },
    ],
    // Два файла корня рабочей области (`mp-clone.md`, «Корень и права»):
    // `.gitignore` и сентинел пишет сама команда; не записав, строка
    // отвечает `сбой`, код 1. Служебные субрепо заведены `git
    // init` заранее — все «уже есть», поэтому ни ssh, ни сервера прогон
    // не касается. Правило `mp-clone` — `allow` (`ALLOWED`).
    [
      "mp-clone: два файла корня пишутся ядром",
      async () => {
        const root = `${subject.home}/mr/mp`;
        await mkdir(root, { recursive: true });
        await writeFile(
          `${root}/mp.code-workspace`,
          JSON.stringify({ folders: [{ path: "." }] }),
        );
        for (const name of ["mp-config-local", "ai-tools", "opiu-service"]) {
          await mkdir(`${root}/${name}`);
          await gitIn(`${root}/${name}`, ["init", "-q"]);
          await gitIn(`${root}/${name}`, [
            "-c",
            "user.name=smoke",
            "-c",
            "user.email=smoke@localhost",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "smoke",
          ]);
        }
        // Сервер прогона стартует с чистым окружением: `git` ищется по
        // PATH, как у ssh выше.
        const outcome = await run(subject, ["mp-clone"], {
          PATH: "/usr/bin:/bin",
        });
        assert.deepStrictEqual(outcome.code, 0, `stderr: ${outcome.stderr}`);
        assert.deepStrictEqual(
          await readFile(`${root}/.mp-workspace-root`, "utf8"),
          "",
        );
        assert.deepStrictEqual(
          await readFile(`${root}/.gitignore`, "utf8"),
          "# Detected subrepos:\n/mp-config-local/\n/ai-tools/\n/opiu-service/\n",
        );
      },
    ],
    // Файл программы `run:` читает ядро (`program-input.md`, «держится
    // на»), ключ вызова — параметр.
    [
      "run: файл программы читается ядром",
      async () => {
        const path = `${subject.home}/probe.mpu`;
        await writeFile(path, "@col print");
        const outcome = await run(subject, ["run:", path, "col:", "review"]);
        assert.deepStrictEqual(
          [outcome.code, outcome.stdout],
          [0, "review\n"],
          `stderr: ${outcome.stderr}`,
        );
      },
    ],
    [
      "sql-ro: выброшенный sw-маршрут отказывает, а не резолвит",
      async () => {
        // Отказ печатает собранный бинарь: маршрута воркспейсов больше
        // нет, а алиас остаётся распознанным ради причины по делу.
        const outcome = await run(subject, [
          "sql-ro",
          "target:",
          "sw",
          "sql:",
          "SELECT 1",
        ]);
        assert.deepStrictEqual(
          outcome.code,
          2,
          `не ошибка ввода: ${outcome.stderr}`,
        );
        assert.deepStrictEqual(
          outcome.stderr,
          "mpu sql-ro: маршрут sw выброшен: доступа к контуру " +
            "воркспейсов нет\n",
        );
        assert.deepStrictEqual(outcome.stdout, "");
      },
    ],
    [
      "схема main-БД: голдены сходятся с information_schema",
      async () => {
        // Единственная проверка smoke, которой нужен живой стенд.
        // Остальное здесь работает всегда, поэтому пропуск тут — не
        // формальность: без него голдены схемы сверялись бы только сами с
        // собой, а расхождение с базой ловила бы живая пара (замер порции
        // 79: колонки `id` в таблице нет вовсе).
        const goldens = await schemaGoldens();
        assert(goldens.length > 0, "голденов схемы нет вовсе");
        const session = await openMainDb();
        try {
          for (const golden of goldens) {
            const live = await liveColumns(session, golden.table);
            if (live.length === 0) {
              throw new Error(
                `таблицы ${golden.table} в main-БД нет, а голден её описывает`,
              );
            }
            // Сверка — общей функцией, проверяемой своим тестом: вторая
            // её копия здесь разошлась бы с первой незаметно.
            const diff = compareColumns(golden.columns, live);
            // Обе стороны названы своими словами: пропавшая колонка и
            // новая — разные новости, и чинятся они по-разному.
            assert.deepStrictEqual(
              diff.missing,
              [],
              `${golden.table}: в базе нет колонок голдена: ${diff.missing.join(
                ", ",
              )}`,
            );
            assert.deepStrictEqual(
              diff.extra,
              [],
              `${golden.table}: в базе есть колонки сверх голдена: ${diff.extra.join(
                ", ",
              )}`,
            );
          }
        } finally {
          await session.close();
        }
      },
    ],
    // Все семь программ установки отвечают версией сборки, ничего не
    // поднимая (`platform/supervisor-install.md`, «Части»): так их
    // проверяет и `install.sh` перед подменой.
    [
      "семь программ: --version, ничего не поднимая",
      async () => {
        for (const [, program] of PROGRAMS) {
          const out = await runProgram(`${subject.home}/${program}`, {
            args: ["--version"],
            clearEnv: true,
            stdout: "piped",
            stderr: "piped",
          });
          assert.deepStrictEqual(
            [out.code, decoder.decode(out.stdout).trim()],
            [0, VERSION],
            `${program}: ${decoder.decode(out.stderr)}`,
          );
        }
      },
    ],
    // Кэш-БД оркестратора (`task-orchestrator.md`, «Порты»): первый шаг
    // идёт сразу при старте и открывает журнал канала — таблицы
    // появляются в `mpu.db`. Не записав, шаг падает строкой лога
    // `шаг: …`, и таблиц нет. Проектов с ролями нет — tmux не зовётся.
    [
      "mpu-task: кэш-БД — таблицы канала при старте",
      async () => {
        const child = await startProgram(subject.task, {
          clearEnv: true,
          env: { HOME: subject.home, XDG_RUNTIME_DIR: subject.runtimeDir },
          stdout: "piped",
          stderr: "piped",
        });
        const tables = await taskTablesWithin(subject.home, 10_000);
        child.kill("SIGTERM");
        const out = await child.output();
        const stdout = decoder.decode(out.stdout);
        assert.deepStrictEqual(
          { code: out.code, tables, stdout },
          { code: 0, tables: true, stdout: "старт\nостановка\n" },
          decoder.decode(out.stderr),
        );
      },
    ],
  ];
}

/** Появились ли таблицы канала в кэш-БД `home` за `ms`. */
async function taskTablesWithin(home: string, ms: number): Promise<boolean> {
  const path = `${home}/.config/mpu/mpu.db`;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await hasTaskTables(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function hasTaskTables(path: string): Promise<boolean> {
  try {
    await stat(path);
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return false;
    throw err;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_projects'",
        )
        .all().length === 1
    );
  } finally {
    db.close();
  }
}

/**
 * Домашний каталог прогона. Заводится в `.tmp` репозитория, а не в
 * системном временном каталоге: в песочнице `/tmp` бывает только на
 * чтение. `.tmp` исключён из инструментов (`biome.jsonc`, `tsconfig.json`),
 * и прогон убирает за собой.
 *
 * Не удалось (каталог только на чтение) — системный временный.
 */
async function makeSubjectHome(): Promise<string> {
  try {
    await mkdir(".tmp", { recursive: true });
    await sweepOldRuns();
    // Путь абсолютный: программы прогона зовутся по нему из любого
    // каталога (`code`, `mp-clone` запускаются не из `ts/`).
    return await realpath(await mkdtemp(join(".tmp", "mpu-smoke-")));
  } catch {
    return await realpath(await mkdtemp(join(tmpdir(), "mpu-smoke-")));
  }
}

/** Права файла восьмеричным числом. */
async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/**
 * Каталоги прежних прогонов, брошенные прерыванием: `finally` на
 * SIGINT не отрабатывает, а внутри каждого лежит собранный бинарь в
 * десятки мегабайт. Раньше их подметал `/tmp`, теперь — некому.
 */
async function sweepOldRuns(): Promise<void> {
  for (const entry of await readdir(".tmp", { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("mpu-smoke-")) continue;
    await rm(`.tmp/${entry.name}`, { recursive: true }).catch(() => {
      // Чужой прогон, идущий прямо сейчас: своё он уберёт сам.
    });
  }
}

async function main(): Promise<number> {
  const home = await makeSubjectHome();
  try {
    // Каталог конфигурации — внутри подменного HOME, но вне
    // `.config/mpu`: иначе проверка границы каталогов ничего бы не
    // доказывала.
    const subject: Subject = {
      back: `${home}/mpu-back`,
      cli: `${home}/mpu`,
      home,
      configHome: `${home}/xdg`,
      task: `${home}/mpu-task`,
      runtimeDir: `${home}/run`,
    };
    console.log("== сборка ==");
    // Все семь — рядом, как у установки: ядро исполняет строки на
    // `mpu-worker` из своего каталога.
    for (const [part, program] of PROGRAMS) {
      await compile(part, `${home}/${program}`);
    }
    // Человек однажды разрешил эти строки: иначе мутирующие отказали
    // бы «спросить некого». До старта сервера — см. `allowLines`.
    await mkdir(`${home}/.config/mpu`, { recursive: true });
    allowLines(home);
    console.log("== проверки ==");
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const [name, check] of checks(subject)) {
      try {
        await check();
        passed++;
        console.log(`  ok   ${name}`);
      } catch (err) {
        if (err instanceof Skipped) {
          skipped++;
          console.log(`  skip ${name}: ${err.message}`);
          continue;
        }
        failed++;
        console.error(
          `  FAIL ${name}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (failed > 0) {
      console.error(`smoke: провалено проверок: ${failed}`);
      return 1;
    }
    // Число исполнившихся проверок печатается всегда: без него
    // исчезнувшая проверка неотличима от зелёного прогона — «зелёный
    // ни о чём» выглядит так же, как настоящий.
    console.log(
      `smoke: бинарь рабочий; проверок: ${passed}` +
        (skipped === 0 ? "" : `, пропущено: ${skipped}`),
    );
    return 0;
  } finally {
    await rm(home, { recursive: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
