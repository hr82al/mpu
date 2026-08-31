/**
 * `deno task smoke` — проверка собранного бинаря на том, чего не видит
 * `deno test`: на правах, зашитых в него при `deno compile`. Тесты идут
 * с широким набором прав, поэтому нехватка `--allow-*` в задаче `build`
 * их не краснит — она видна только запуску самого бинаря.
 *
 * Бинарь собирается во временный каталог внутри `.tmp` репозитория
 * (`makeSubjectHome`: под `/tmp` утверждения о правах записи слепнут),
 * и он же служит ему HOME:
 * `$HOME` в правах задачи `build` подставляется этим каталогом, так что
 * всё, что бинарь пишет в домашний каталог, остаётся во временном.
 * Активная установка (`~/.local/bin/mpu`) и настоящий rc-файл не
 * трогаются.
 *
 * Проверки идут с `clearEnv`: у бинаря есть ровно те переменные, что
 * заданы явно, — иначе «прочитал окружение» не отличить от «унаследовал
 * его от нас».
 */

import { assert, assertEquals } from "@std/assert";
import { VERSION } from "../src/version.ts";
import { REQUIRES_INTERACTION } from "../src/mcp/tool.ts";
import { PROTOCOL_VERSION } from "../src/mcp/jsonrpc.ts";
import { DEFAULT_LEGACY_BIN } from "../src/legacy/mod.ts";
import { HEADERS_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from "../src/http/mod.ts";
import { WARMUP_BUDGET_MS } from "../src/kaiten/mod.ts";
import { envFilePath, makeEnvFile } from "../src/env/mod.ts";
import { makeEnvFileStore } from "../src/runtime/mod.ts";
import { denoSession } from "../src/sql/mod.ts";
import {
  compareColumns,
  schemaCheckPlan,
  schemaGoldens,
  skipCause,
  skipReason,
} from "../src/api/schema_golden.ts";

/**
 * Значения `_MPU_COMPLETE` и переменные, которые подставляет shell.
 * Повторяют эталон скрипта дополнения
 * (`fixtures/platform/registry/completion-*.txt`): здесь мы играем роль
 * shell, а не зовём код точки входа.
 */
const COMPLETE_ENV = "_MPU_COMPLETE";
const COMPLETE_BASH = "complete_bash";
const COMPLETE_ZSH = "complete_zsh";

/** Строка, которой `mpu mcp` сообщает, что сокет уже слушает. */
const LISTEN_MARKER = "слушаю http://";

/** Файл журнала вызовов smoke-прогона: ключ `MPU_LOG_FILE` env-файла. */
const INVOKE_LOG_NAME = "$HOME/.config/mpu/invoke.log";

/** `run_id` записи, которую оставляет заглушка вместо Python-реализации. */
const LEGACY_RUN_ID = "20260805-000000.000-1";

const decoder = new TextDecoder();

/**
 * Проверка неисполнима в этом окружении. Не «зелёная»: пропуск
 * печатается отдельным словом и считается в итоговой строке — иначе
 * список прав выглядел бы покрытым, не будучи им.
 */
class Skipped extends Error {
  override name = "Skipped";
}

/**
 * Собранный бинарь и два каталога, которыми ему подменяют окружение:
 * `home` — состояние (`HOME`), `configHome` — конфигурация
 * (`XDG_CONFIG_HOME`). Второй нужен и на сборке: путь в
 * `--allow-write` запекается в бинарь, а не читается при запуске.
 */
interface Subject {
  readonly bin: string;
  readonly home: string;
  readonly configHome: string;
}

/** Результат запуска бинаря. */
interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  subject: Subject,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Outcome> {
  const output = await new Deno.Command(subject.bin, {
    args: [...args],
    env: { HOME: subject.home, ...env },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

/** Отсутствие файла как утверждение: есть — проверка красная. */
async function assertMissing(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
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
  assertEquals(
    outcome.code,
    0,
    `mpu ${args.join(" ")} завершился с ${outcome.code}: ${outcome.stderr}`,
  );
  return outcome;
}

/**
 * Аргументы `deno compile` из задачи `build`. Список прав здесь не
 * переписывается: иначе smoke проверял бы не те права, с которыми
 * бинарь ставится. Подменяются только путь вывода и два каталога
 * окружения — `HOME` и `XDG_CONFIG_HOME`.
 */
function buildArgs(denoJsonc: string, subject: Subject): string[] {
  const task = denoJsonc.match(/"build":\s*"([^"]*)"/)?.[1];
  if (task === undefined) throw new Error("в deno.jsonc нет задачи build");
  const args = task.split(/\s+/).slice(1).map((arg) =>
    arg.replaceAll("$HOME", subject.home).replaceAll(
      "$XDG_CONFIG_HOME",
      subject.configHome,
    )
  );
  const out = args.indexOf("-o");
  if (out < 0) throw new Error("в задаче build нет -o");
  args[out + 1] = subject.bin;
  return args;
}

/**
 * Env-файл для прогона `copy-dev`: обязательные ключи источника,
 * указанные на петлю с заведомо закрытым портом. Дальше создания
 * временного файла вызов и не должен уходить — `pg_dump` не находится
 * вовсе, потому что окружение подпроцесса не несёт PATH.
 */
async function writeCopyDevEnv(subject: Subject): Promise<void> {
  const path = `${subject.home}/.config/mpu/.env`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(
    path,
    "DEV_WORKSPACES_HOST=127.0.0.1\nDEV_WORKSPACES_PORT=1\n" +
      "DEV_WORKSPACES_USER=smoke\nDEV_WORKSPACES_PASSWORD=smoke\n",
  );
}

/** Убирает env-файл прогона: следующая проверка пишет свой. */
async function removeEnvFile(subject: Subject): Promise<void> {
  await Deno.remove(`${subject.home}/.config/mpu/.env`).catch(() => {});
}

/**
 * Пригоден ли `/tmp` для записи в этом окружении. Зонд делает сам
 * smoke, а не бинарь: у бинаря отказ файловой системы и отказ прав
 * выглядят по-разному, но проверять надо второе, и путать их нельзя.
 */
function probeTempDir(): void {
  let path: string;
  try {
    path = Deno.makeTempFileSync({ dir: "/tmp", prefix: "mpu-smoke-probe-" });
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : "";
    throw new Skipped(`/tmp недоступен на запись в этом окружении: ${reason}`);
  }
  try {
    Deno.removeSync(path);
  } catch {
    // Зонд убирает за собой best-effort: оставшийся файл ничему не мешает.
  }
}

/**
 * Годится ли подменный HOME для утверждения о праве записи.
 *
 * Под `/tmp` и `/var/tmp` любая запись покрыта соседним правом из того
 * же списка (`--allow-write=…,/tmp,/var/tmp`), поэтому проверка,
 * которая называет своим предметом право на `$HOME/...`, зеленела бы и
 * со снятым правом — она проверяла бы чужое. Зовётся из КАЖДОЙ такой
 * проверки, а не из одной: слепо оказывается любое утверждение о
 * праве, а не какое-то избранное.
 *
 * Обычно до пропуска не доходит: домашний каталог прогона заводится
 * вне `/tmp` (`makeSubjectHome`). Пропуск остаётся для окружений, где
 * это не удалось, и называет путь — пересказ «временный каталог не
 * тот» скрыл бы, какой именно.
 */
function requireOutsideTempPermission(...paths: readonly string[]): void {
  for (const covered of ["/tmp/", "/var/tmp/"]) {
    for (const home of paths) {
      if (!home.startsWith(covered)) continue;
      throw new Skipped(
        `каталог прогона под ${covered.slice(0, -1)} — запись туда покрыта ` +
          `соседним правом того же списка: ${home}`,
      );
    }
  }
}

async function compile(subject: Subject): Promise<void> {
  const args = buildArgs(await Deno.readTextFile("deno.jsonc"), subject);
  const compiled = await new Deno.Command("deno", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!compiled.success) throw new Error("deno compile не собрал бинарь");
}

/**
 * Заглушка Python-реализации на месте, где её ищет маршрут `legacy`:
 * без неё подпроцесс не запускается и право `--allow-run` остаётся
 * непроверенным.
 *
 * Заглушка дописывает и запись в журнал вызовов: у настоящей
 * реализации журнал свой, и проверка «обвязка второй записи не делает»
 * без этого проверяла бы пустоту (`platform/invoke-log.md`).
 */
async function installFakeLegacy(subject: Subject): Promise<void> {
  const path = DEFAULT_LEGACY_BIN.replace("~", subject.home);
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(
    path,
    `#!/bin/sh
mkdir -p "$HOME/.config/mpu"
printf '### legacy run=%s pid=1 cwd=/\\n$ mpu %s\\n--- end run=%s exit=0 dur=0.001s ---\\n\\n' \\
  "${LEGACY_RUN_ID}" "$*" "${LEGACY_RUN_ID}" >> "${INVOKE_LOG_NAME}"
if [ "$1" = version ]; then echo ${VERSION}; else echo legacy-ok; fi
`,
    { mode: 0o755 },
  );
}

/** Строки команд из журнала: по одной на запись. */
function logRecords(text: string): readonly string[] {
  return text.split("\n").filter((line) => line.startsWith("$ mpu "));
}

/** Ждёт сообщение о старте сервера; поток кончился — сервер не встал. */
async function waitForListening(
  stderr: ReadableStream<Uint8Array>,
): Promise<number> {
  let text = "";
  for await (const chunk of stderr) {
    text += decoder.decode(chunk);
    // Порт выдаёт ОС (`--port 0`), и узнать его можно только отсюда.
    const port = /слушаю http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
    if (port !== null) return Number(port[1]);
    if (text.includes(LISTEN_MARKER)) {
      throw new Error(`в сообщении о старте нет порта: ${text.trim()}`);
    }
  }
  throw new Error(`сервер не сообщил о старте: ${text.trim()}`);
}

/**
 * `mpu mcp` разом проверяет права слушающего сокета, записи токена и
 * подпроцесса сверки версий, а поднятый сервер — то, что видно только
 * снаружи: аннотации тулов в ответе `tools/list`.
 */
async function checkMcpServer(subject: Subject): Promise<void> {
  // Файл токена сервер заводит сам — ещё одно утверждение о праве на
  // каталог состояния, слепое под `/tmp`.
  requireOutsideTempPermission(subject.home);
  const child = new Deno.Command(subject.bin, {
    args: ["mcp", "--port", "0", "--profile", "rw"],
    env: { HOME: subject.home },
    clearEnv: true,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  try {
    const port = await waitForListening(child.stderr);
    const token = (await Deno.readTextFile(`${subject.home}/.config/mpu/token`))
      .trim();
    await checkToolAnnotations(port, token);
    const info = await Deno.stat(`${subject.home}/.config/mpu/token`);
    // mode отсутствует там, где у файловой системы нет прав POSIX.
    if (info.mode === null) return;
    assertEquals(
      (info.mode & 0o777).toString(8),
      "600",
      "права файла токена не 0600",
    );
  } finally {
    stopServer(child);
    await child.status;
  }
}

/** Тул в ответе `tools/list` — ровно то, что нужно этой проверке. */
interface ListedTool {
  readonly name: string;
  readonly annotations: { readonly destructiveHint?: boolean };
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/**
 * Аннотации необратимых тулов видны только снаружи: `deno test` берёт
 * их из сборки профилей, а клиент — из ответа по HTTP. Здесь проверяем
 * именно ответ поднятого бинаря.
 */
async function checkToolAnnotations(
  port: number,
  token: string,
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/rw`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": "tools/list",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assertEquals(response.status, 200, "tools/list не ответил");
  const body = await response.json() as { result: { tools: ListedTool[] } };
  const find = (name: string) => {
    const tool = body.result.tools.find((item) => item.name === name);
    assert(tool !== undefined, `в профиле rw нет тула ${name}`);
    return tool;
  };
  // Необратимый: помечен обоими способами — аннотацией и `_meta`.
  const destructive = find("sql");
  assertEquals(destructive.annotations.destructiveHint, true);
  assertEquals(destructive._meta?.[REQUIRES_INTERACTION], true);
  // Мутирующий, но локальный: не помечен ни тем, ни другим.
  const local = find("xlsx_alias_add");
  assertEquals(local.annotations.destructiveHint, undefined);
  assertEquals(local._meta, undefined);
}

/**
 * Гасит сервер. Сервер мог упасть сам — тогда гасить нечего, и эта
 * ошибка не должна затирать настоящую причину падения; прочие ошибки
 * гашения — наружу.
 */
function stopServer(child: Deno.ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
  }
}

/** Проверка: имя для отчёта и запуск, падающий с объяснением. */
type Check = readonly [name: string, run: () => Promise<void>];

/**
 * Сессия main-БД по реквизитам оператора. Недостижимая база — пропуск,
 * а не провал: стенд поднимают не всегда, и «не с чем сверять» — другой
 * исход, чем «сверили и разошлось».
 */
async function openMainDb() {
  const path = envFilePath((name) => Deno.env.get(name));
  const envFile = makeEnvFile(
    path === undefined ? undefined : makeEnvFileStore(path),
  );
  const plan = schemaCheckPlan(envFile);
  if (plan.kind === "skip") throw new Skipped(plan.reason);
  try {
    return await denoSession("read-only")(plan.target);
  } catch (err) {
    // Причина называется своя: нехватка права и погашенный стенд
    // лечатся в разных местах, и первая не должна маскироваться второй.
    throw new Skipped(skipReason(skipCause(err), reasonLine(err)));
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

function checks(subject: Subject): readonly Check[] {
  return [
    ["version", async () => {
      const outcome = await runOk(subject, ["version"]);
      assertEquals(outcome.stdout.trim(), VERSION, "не та версия");
    }],
    ["дополнение bash", async () => {
      const outcome = await runOk(subject, [], {
        [COMPLETE_ENV]: COMPLETE_BASH,
        COMP_WORDS: "mpu ver",
        COMP_CWORD: "1",
      });
      assert(
        outcome.stdout.split("\n").includes("version"),
        `среди вариантов нет version: ${JSON.stringify(outcome.stdout)}`,
      );
    }],
    ["дополнение zsh", async () => {
      const outcome = await runOk(subject, [], {
        [COMPLETE_ENV]: COMPLETE_ZSH,
        _TYPER_COMPLETE_ARGS: "mpu ver",
      });
      assert(
        outcome.stdout.includes(`"version"`),
        `среди вариантов нет version: ${JSON.stringify(outcome.stdout)}`,
      );
    }],
    // Оба shell разом: rc-файлы разрешены поимённо, и промах по
    // любому из них — отказ в записи уже у пользователя.
    ["установка дополнения в rc-файлы", async () => {
      requireOutsideTempPermission(subject.home);
      for (const [shell, rc] of [["bash", ".bashrc"], ["zsh", ".zshrc"]]) {
        await runOk(subject, ["--install-completion", shell]);
        const text = await Deno.readTextFile(`${subject.home}/${rc}`);
        assert(text.includes("_mpu_completion"), `скрипт не дописан в ${rc}`);
      }
    }],
    // Право на каталог временных файлов: дамп `copy-client`/`copy-dev`
    // пишется во временный файл, и без права бинарь падает `Requires
    // write access to <TMP>` ещё до первого обращения к PG. Тесты этого
    // не видят — они идут с широкими правами.
    //
    // Сети здесь нет: адрес источника указан на петлю с заведомо
    // закрытым портом, а `pg_dump` не находится вовсе — окружение
    // подпроцесса не несёт PATH. Дальше создания временного файла
    // вызов и не должен уходить: проверяется ровно право.
    [
      "временный файл дампа: право на каталог зашито в бинарь",
      async () => {
        // Зонд — до всякой подготовки: бинарь идёт с очищенным
        // окружением, поэтому каталогом временных файлов у него будет
        // `/tmp`, и если он недоступен на запись (так бывает в
        // песочницах), проверять право нечем — отказ пришёл бы от
        // файловой системы, а не от прав.
        probeTempDir();
        await writeCopyDevEnv(subject);
        try {
          const outcome = await run(subject, ["copy-dev"]);
          const text = `${outcome.stdout}${outcome.stderr}`;
          // Путь дампа виден в строке запуска `pg_dump`, которую команда
          // печатает уже после создания файла: его наличие и означает,
          // что право сработало. Сырого текста Deno здесь не бывает —
          // отказ прав переведён в доменный, — поэтому страхует именно
          // эта проверка, а не поиск «Requires write access».
          assert(
            /\/tmp\/mpu-copy-dev-\w+\.dump/.test(text),
            `в выводе нет пути временного дампа под /tmp: ${
              JSON.stringify(text)
            }`,
          );
        } finally {
          await removeEnvFile(subject);
        }
      },
    ],
    // Оборотная сторона той же проверки: каталог вне списка прав
    // отбивается, а отказ приходит нашим текстом, а не сырым «Requires
    // write access to <TMP>», из которого оператору не видно ни
    // каталога, ни что делать.
    //
    // Каталог берётся соседом домашнего внутри `.tmp/`, а не его
    // потомком: право задачи `build` перечисляет пути под `$HOME`, и
    // сосед им не покрыт — именно это здесь и проверяется.
    //
    // Предпосылка проверки — «этот каталог правом НЕ покрыт», и она
    // ложна, когда дерево лежит под `/tmp`: сосед оказывается внутри
    // покрытого пути, отказа нет, прогон доходит до запуска `pg_dump`
    // и краснеет чужой причиной (замер спецификатора 2026-08-31). Тот
    // же страж, что у утверждений о праве, только здесь он бережёт от
    // ЛОЖНОЙ красноты, а не от ложной зелени.
    [
      "каталог временных файлов вне прав отбивается понятным текстом",
      async () => {
        const outside = await Deno.realPath(
          await ensureDir(`${Deno.cwd()}/.tmp/smoke-вне-прав`),
        );
        requireOutsideTempPermission(outside);
        await writeCopyDevEnv(subject);
        try {
          const outcome = await run(subject, ["copy-dev"], { TMPDIR: outside });
          const text = `${outcome.stdout}${outcome.stderr}`;
          assert(
            text.includes("нет права записи в каталог временных файлов"),
            `отказ пришёл не нашим текстом: ${JSON.stringify(text)}`,
          );
          assert(
            !text.includes("Requires write access"),
            `сырой текст Deno дошёл до оператора: ${JSON.stringify(text)}`,
          );
        } finally {
          await removeEnvFile(subject);
          await Deno.remove(outside, { recursive: true }).catch(() => {});
        }
      },
    ],
    [
      "MPU_XLSX: ключ env-файла читается, окружение процесса — нет",
      async () => {
        const book = `${subject.home}/book.xlsx`;
        await Deno.writeTextFile(book, "");
        const envPath = `${subject.home}/.config/mpu/.env`;
        await Deno.mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });

        await Deno.writeTextFile(envPath, `MPU_XLSX=${book}\n`);
        const fromFile = await runOk(subject, ["xlsx", "resolve", "--json"]);
        // Форму результата объявляет схема команды; здесь важен только
        // победивший источник — что ключ env-файла вообще прочитан.
        const fileResult = JSON.parse(fromFile.stdout) as {
          resolved: { source: string } | null;
        };
        assertEquals(
          fileResult.resolved?.source,
          "env",
          "путь пришёл не из env-файла",
        );

        // Обратный случай: та же книга, ключа в env-файле нет, но он
        // экспортирован в окружение процесса — путь не резолвится вовсе
        // (других источников тоже нет). Это и есть smoke-подтверждение
        // того, что окружение процесса больше не читается.
        await Deno.remove(envPath);
        const fromProcessEnv = await runOk(subject, [
          "xlsx",
          "resolve",
          "--json",
        ], {
          MPU_XLSX: book,
        });
        const envResult = JSON.parse(fromProcessEnv.stdout) as {
          resolved: { source: string } | null;
        };
        assertEquals(
          envResult.resolved,
          null,
          "путь резолвился из окружения процесса вопреки его исключению из чтения",
        );
      },
    ],
    [
      // Клиент MTProto подгружается лениво (`src/telegram/cmd_send.ts`):
      // `deno test` этого не проверяет вовсе — там модуль резолвит
      // рантайм, а не бинарь. Здесь вызов доходит до сеанса и падает на
      // фиктивной строке сессии: значит модуль в бинаре есть и прав ему
      // хватает. Сети проверка не касается — до неё дело не доходит.
      "telegram send: ленивый клиент MTProto есть в бинаре",
      async () => {
        const envPath = `${subject.home}/.config/mpu/.env`;
        await Deno.mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(
          envPath,
          "TELEGRAM_API_ID=1\nTELEGRAM_API_HASH=проба\n" +
            "TELEGRAM_SESSION=не-строка-сессии\n",
        );
        const outcome = await run(subject, [
          "telegram",
          "send",
          "привет",
          "--chat",
          "me",
        ]);
        await Deno.remove(envPath);
        assertEquals(
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
    ["init: справка собранного бинаря несёт числа пределов", async () => {
      const outcome = await runOk(subject, ["init", "--help"]);
      for (
        const value of [HEADERS_TIMEOUT_MS, TOTAL_TIMEOUT_MS, WARMUP_BUDGET_MS]
      ) {
        assert(
          outcome.stdout.includes(String(value)),
          `в справке init нет числа ${value}`,
        );
      }
    }],
    // Единственная проверка, поднимающая сеть: она же и единственная,
    // которой права `--allow-net` и `--allow-write=$HOME/.config/mpu`
    // нужны одновременно — бинарь ходит в Portainer и заводит кэш-БД.
    // Конфигурация приходит только из env-файла: окружение подпроцесса
    // очищено (`clearEnv`), в нём есть один HOME.
    ["init: discovery через фейковый Portainer и кэш-БД в HOME", async () => {
      // Файл кэш-БД заводит сам бинарь — это и есть утверждение о
      // праве на каталог состояния, и оно слепо под `/tmp`.
      requireOutsideTempPermission(subject.home);
      const server = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/endpoints") {
            return Response.json([{ Id: 1, Name: "prod", Status: 1 }]);
          }
          return Response.json([{
            Id: "c1",
            Names: ["/sl-1-cli"],
            State: "running",
            Image: "img",
          }]);
        },
      );
      try {
        const envPath = `${subject.home}/.config/mpu/.env`;
        await Deno.mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(
          envPath,
          "PORTAINER_API_KEY=proba-kluch\n" +
            `PORTAINER_URL=http://127.0.0.1:${server.addr.port}\n`,
        );
        const outcome = await runOk(subject, ["init", "--dry-run"]);
        assert(
          outcome.stdout.includes("sl-1: sl-1-cli [running]"),
          `сводка не та: ${JSON.stringify(outcome.stdout)}`,
        );
        assert(
          outcome.stderr.includes("# bootstrap: схема в"),
          `нет строки шага 1: ${JSON.stringify(outcome.stderr)}`,
        );
        // Файл кэш-БД заведён самим бинарём — это и есть проверка права
        // на запись в каталог состояния для нового файла.
        await Deno.stat(`${subject.home}/.config/mpu/mpu.db`);
        await Deno.remove(envPath);
      } finally {
        await server.shutdown();
      }
    }],
    // Проверка права `--allow-env=…,PG*`: клиент PostgreSQL читает
    // умолчания опций из окружения, и те, чьё умолчание ложно
    // (`PGBINARY`, `PGREPLICATION`), явной опцией не перекрываются —
    // без права клиент не создаётся вовсе, и команда падала бы отказом
    // прав вместо отказа сети. Живого PG здесь нет и не нужно: адрес
    // заведомо закрыт, ценно то, КАКОЙ ошибкой команда завершается.
    ["update: PG-клиент отказывает по сети, а не по правам", async () => {
      const envPath = `${subject.home}/.config/mpu/.env`;
      await Deno.mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(
        envPath,
        "pg_0=127.0.0.1\nPG_PORT=1\n" +
          "PG_MAIN_USER_NAME=proba\nPG_MAIN_USER_PASSWORD=proba\n",
      );
      const outcome = await run(subject, ["update"]);
      assertEquals(outcome.code, 1, `stderr: ${outcome.stderr}`);
      assert(
        outcome.stderr.startsWith("mpu update: main (sl-0) недоступен: "),
        `не тот отказ: ${JSON.stringify(outcome.stderr)}`,
      );
      assert(
        !outcome.stderr.includes("Requires env access"),
        `клиенту PG не хватило права: ${JSON.stringify(outcome.stderr)}`,
      );
      await Deno.remove(envPath);
    }],
    // Граница состояния и конфигурации на собранном бинаре: `HOME`
    // адресует кэш-БД и журнал, `XDG_CONFIG_HOME` — env-файл и
    // выведенный из его кред токен-кэш sl-back. Разводит каталоги одна
    // строка `main.ts`, и проверить её можно только запуском: тесты
    // зовут `makeDenoIo` сами и подстановку из точки входа не видят.
    // Она же — единственное покрытие права
    // `--allow-write=…,$XDG_CONFIG_HOME/mpu`: снять право — и кэш не
    // появится (отказ записи глотает сам слой, `slback-http.md`,
    // поэтому наблюдаемое здесь — отсутствие файла, а не текст отказа).
    //
    // Покрытие настоящее не везде, и это названо, а не
    // подразумевается: каталоги прогона заводятся вне `/tmp`
    // намеренно (`makeSubjectHome`), но там, где это не удалось —
    // репозиторий сам лежит под `/tmp`, — запись покрыта соседним
    // правом того же списка, и снятое право осталось бы
    // незамеченным. Там проверка честно пропускается, а не зеленеет.
    [
      "границы каталогов: XDG_CONFIG_HOME уводит токен-кэш, но не кэш-БД",
      async () => {
        requireOutsideTempPermission(subject.home, subject.configHome);
        const server = Deno.serve(
          { port: 0, hostname: "127.0.0.1", onListen: () => {} },
          () => Response.json({ accessToken: "проба-токена" }),
        );
        const cachePath = `${subject.configHome}/mpu/.api-token.json`;
        try {
          await Deno.mkdir(`${subject.configHome}/mpu`, { recursive: true });
          await Deno.writeTextFile(
            `${subject.configHome}/mpu/.env`,
            `BASE_API_URL=http://127.0.0.1:${server.addr.port}\n` +
              "TOKEN_EMAIL=proba@example.com\nTOKEN_PASSWORD=proba\n",
          );
          const outcome = await runOk(subject, ["api", "get-token"], {
            XDG_CONFIG_HOME: subject.configHome,
          });
          assertEquals(outcome.stdout.trim(), "проба-токена", "не тот токен");
          // Кэш лёг рядом с кредами, из которых токен получен. Права
          // файла проверяет юнит-тест слоя (`src/runtime/mod_test.ts`):
          // они видны и без запуска бинаря, а здесь ценно право.
          await Deno.stat(cachePath);
          // И не лёг в каталог состояния: иначе токен подменного
          // сервера переиспользовался бы основной конфигурацией.
          await assertMissing(`${subject.home}/.config/mpu/.api-token.json`);
        } finally {
          await server.shutdown();
          await Deno.remove(`${subject.configHome}/mpu`, { recursive: true });
        }
      },
    ],
    // Переехавшая команда на собранном бинаре: `--dry-run` печатает
    // план и не ходит в службу. Доски у smoke нет и быть не должно —
    // живая пара за спецификатором; здесь проверяется, что маршрут
    // `native` у команды рабочий и фикстуры читаются.
    ["d2-miro: план --dry-run печатается собранным бинарём", async () => {
      const base = `${subject.home}/схема`;
      const from = new URL(
        "../src/d2miro/testdata/d2-miro/",
        import.meta.url,
      );
      // Порядок копирования значим: SVG обязан быть не старше `.d2`,
      // иначе бинарь пойдёт звать `d2`, которого в окружении нет.
      await Deno.writeTextFile(
        `${base}.d2`,
        await Deno.readTextFile(new URL("sample.d2", from)),
      );
      await Deno.writeTextFile(
        `${base}.svg`,
        await Deno.readTextFile(new URL("sample.svg", from)),
      );
      const outcome = await runOk(subject, [
        "d2-miro",
        `${base}.d2`,
        "--dry-run",
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
    }],
    ["маршрут legacy", async () => {
      // Образец подпроцессной команды — `iu-wb`: `search`, `sheet` и
      // `d2-miro` переехали на маршрут `native`.
      const outcome = await runOk(subject, ["iu-wb", "--help"]);
      assert(
        outcome.stdout.includes("legacy-ok"),
        `подпроцесс не отработал: ${JSON.stringify(outcome.stdout)}`,
      );
    }],
    // Журнал вызовов: одна запись на вызов и ни одной лишней. Права на
    // файл берутся из `--allow-write=$HOME/.config/mpu` — журнал живёт
    // в каталоге состояния, а путь приходит ключом env-файла, не
    // окружением процесса (`platform/invoke-log.md`).
    ["журнал вызовов: по записи на вызов, legacy пишет сам", async () => {
      // Журнал пишет бинарь, и права на него — из того же списка.
      requireOutsideTempPermission(subject.home);
      const configDir = `${subject.home}/.config/mpu`;
      const logPath = `${configDir}/invoke.log`;
      await Deno.mkdir(configDir, { recursive: true });
      await Deno.writeTextFile(
        `${configDir}/.env`,
        `MPU_LOG_FILE=${logPath}\n`,
      );
      try {
        await Deno.remove(logPath);
      } catch {
        // Файла ещё нет, если проверка маршрута `legacy` выше не
        // добралась до него: считаем записи этой проверки, а не прогона.
      }
      try {
        await runOk(subject, ["xlsx", "resolve", "--json"]);
        const afterNative = await Deno.readTextFile(logPath);
        assertEquals(
          logRecords(afterNative),
          ["$ mpu xlsx resolve --json"],
          `не одна запись native-вызова: ${JSON.stringify(afterNative)}`,
        );
        assertEquals(
          ((await Deno.stat(logPath)).mode ?? 0o600) & 0o777,
          0o600,
          "права файла журнала не 0600",
        );

        await runOk(subject, ["iu-wb", "--help"]);
        const afterLegacy = await Deno.readTextFile(logPath);
        // Вторая запись — от подпроцесса; обвязка для маршрута `legacy`
        // своей не делает, иначе записей было бы три.
        assertEquals(
          logRecords(afterLegacy),
          ["$ mpu xlsx resolve --json", "$ mpu iu-wb --help"],
          `записи маршрута legacy задвоились: ${JSON.stringify(afterLegacy)}`,
        );
        assertEquals(
          afterLegacy.split(`run=${LEGACY_RUN_ID}`).length - 1,
          2,
          "запись legacy-вызова пришла не от подпроцесса",
        );
      } finally {
        await Deno.remove(`${configDir}/.env`);
      }
    }],
    // Единственная проверка, поднимающая клиент PostgreSQL: она же
    // подтверждает право `--allow-env=PG*` — без него драйвер не
    // создаётся вовсе (`NotCapable` ещё до подключения). Живого
    // PostgreSQL у smoke нет, поэтому адрес заведомо закрытый: важно,
    // что отказ пришёл от драйвера, а не от прав.
    ["sql-ro: мета-блок из env-файла и живой PG-клиент", async () => {
      const configDir = `${subject.home}/.config/mpu`;
      await Deno.mkdir(configDir, { recursive: true });
      await Deno.writeTextFile(
        `${configDir}/.env`,
        "pg_1=127.0.0.1\nPG_PORT=1\nPG_MY_USER_NAME=u\nPG_MY_USER_PASSWORD=p\n",
      );
      try {
        const dry = await runOk(subject, [
          "sql-ro",
          "sl-1",
          "SELECT 1",
          "--dry",
          "-v",
        ]);
        assertEquals(dry.stdout, "", "у --dry stdout обязан быть пуст");
        assertEquals(
          dry.stderr,
          "server: sl-1\npg_host: 127.0.0.1\npg_port: 1\ndatabase: wb\n" +
            "mode: read-only\nsql:\nSELECT 1\n",
          "мета-блок собран не из env-файла",
        );

        const live = await run(subject, ["sql-ro", "sl-1", "SELECT 1"]);
        assertEquals(live.code, 1, `не отказ БД: ${JSON.stringify(live)}`);
        assert(
          live.stderr.startsWith("db error: "),
          `отказ не от драйвера: ${JSON.stringify(live.stderr)}`,
        );
        assert(
          !live.stderr.includes("NotCapable"),
          `драйверу не хватило прав бинаря: ${live.stderr}`,
        );
      } finally {
        await Deno.remove(`${configDir}/.env`);
      }
    }],
    ["схема main-БД: голдены сходятся с information_schema", async () => {
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
          assertEquals(
            diff.missing,
            [],
            `${golden.table}: в базе нет колонок голдена: ${
              diff.missing.join(", ")
            }`,
          );
          assertEquals(
            diff.extra,
            [],
            `${golden.table}: в базе есть колонки сверх голдена: ${
              diff.extra.join(", ")
            }`,
          );
        }
      } finally {
        await session.close();
      }
    }],
    ["mcp: сокет, токен, аннотации тулов", () => checkMcpServer(subject)],
  ];
}

/**
 * Домашний каталог прогона. Заводится в `.tmp` репозитория, а не в
 * системном временном каталоге: под `/tmp` все утверждения о правах
 * записи слепнут — соседнее право того же списка покрывает их разом
 * (`requireOutsideTempPermission`). `.tmp` исключён из инструментов
 * (`deno.jsonc`), и прогон убирает за собой.
 *
 * Не удалось (каталог только на чтение) — системный временный, и
 * тогда проверки прав честно пропускаются, а не зеленеют вхолостую.
 */
async function makeSubjectHome(): Promise<string> {
  try {
    await Deno.mkdir(".tmp", { recursive: true });
    await sweepOldRuns();
    // Путь абсолютный, и это не косметика: страж сверяет его с `/tmp`
    // и `/var/tmp` по началу строки, а относительный `.tmp/…` не
    // совпал бы никогда — репозиторий, выложенный под `/tmp`, вернул
    // бы ровно ту слепоту, ради которой всё и делается.
    return await Deno.realPath(
      await Deno.makeTempDir({ dir: ".tmp", prefix: "mpu-smoke-" }),
    );
  } catch {
    return await Deno.realPath(
      await Deno.makeTempDir({ prefix: "mpu-smoke-" }),
    );
  }
}

/** Создаёт каталог, если его нет, и возвращает его путь. */
async function ensureDir(path: string): Promise<string> {
  await Deno.mkdir(path, { recursive: true });
  return path;
}

/**
 * Каталоги прежних прогонов, брошенные прерыванием: `finally` на
 * SIGINT не отрабатывает, а внутри каждого лежит собранный бинарь в
 * десятки мегабайт. Раньше их подметал `/tmp`, теперь — некому.
 */
async function sweepOldRuns(): Promise<void> {
  for await (const entry of Deno.readDir(".tmp")) {
    if (!entry.isDirectory || !entry.name.startsWith("mpu-smoke-")) continue;
    await Deno.remove(`.tmp/${entry.name}`, { recursive: true }).catch(() => {
      // Чужой прогон, идущий прямо сейчас: своё он уберёт сам.
    });
  }
}

async function main(): Promise<number> {
  const home = await makeSubjectHome();
  try {
    // Каталог конфигурации — внутри подменного HOME, но вне
    // `.config/mpu`: право задачи `build` перечисляет именно
    // `.config/mpu`, и запись в `xdg/mpu` им не покрыта — иначе
    // проверка границы ничего бы не доказывала.
    const subject: Subject = {
      bin: `${home}/mpu`,
      home,
      configHome: `${home}/xdg`,
    };
    console.log("== сборка ==");
    await compile(subject);
    await installFakeLegacy(subject);
    console.log("== проверки ==");
    let failed = 0;
    let skipped = 0;
    for (const [name, check] of checks(subject)) {
      try {
        await check();
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
    console.log(
      skipped === 0
        ? "smoke: бинарь рабочий"
        : `smoke: бинарь рабочий; пропущено проверок: ${skipped}`,
    );
    return 0;
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
