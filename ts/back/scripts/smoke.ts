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
import { GRAMMAR } from "../src/messages/mod.ts";
import { HEADERS_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from "../src/http/mod.ts";
import { WARMUP_BUDGET_MS } from "../src/kaiten/mod.ts";
import {
  BACK_TASK,
  CLI_TASK,
  compileArgs,
  CompileTaskError,
} from "./compile_task.ts";
import { envFilePath, makeEnvFile } from "../src/env/mod.ts";
import { ALLOW, RuleBook, RulePath } from "../src/policy/mod.ts";
import { policyFile } from "../src/line/mod.ts";
import { makeEnvFileStore } from "../src/runtime/mod.ts";
import { denoSession } from "../src/sql/mod.ts";
import {
  compareColumns,
  schemaCheckPlan,
  schemaGoldens,
  skipCause,
  skipReason,
} from "../src/api/schema_golden.ts";

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
 * Предмет прогона: пара собранных программ, которыми человек и
 * пользуется, — сервер строк и клиент, — и два каталога, которыми им
 * подменяют окружение: `home` — состояние (`HOME`), `configHome` —
 * конфигурация (`XDG_CONFIG_HOME`). Второй нужен и на сборке: путь в
 * `--allow-write` запекается в бинарь, а не читается при запуске.
 */
interface Subject {
  /** `mpu-back`: исполняет строки. */
  readonly back: string;
  /** `mpu`: тонкий клиент, которым строка подаётся. */
  readonly cli: string;
  readonly home: string;
  readonly configHome: string;
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
  const child = new Deno.Command(subject.back, {
    args: ["--port", "0"],
    env: { HOME: subject.home, ...env },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const reader = child.stdout.getReader();
  const stop = async () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Сервер уже мёртв — гасить нечего, и это не ошибка прогона.
    }
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
  const output = await new Deno.Command(subject.cli, {
    args: [...args],
    // `PATH` клиенту не даётся намеренно: программы копирования
    // перечислены в его правах абсолютными путями, и старт без `PATH`
    // — проверяемое свойство, а не удобство прогона
    // (`cli-client.md`, «Права клиента и `PATH`»).
    env: { HOME: subject.home, MPU_BACK_URL: url },
    clearEnv: true,
    cwd,
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
  "init",
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

/**
 * Собирает программу прогона. Аргументы — из её задачи
 * (`compile_task.ts`): список прав здесь не переписывается, иначе smoke
 * проверял бы не те права, с которыми собирается программа. Подменяются
 * только путь вывода и два каталога окружения.
 *
 * @param task имя задачи сборки
 * @param out путь готовой программы
 * @param where каталоги, которыми раскрываются переменные прав
 */
async function compile(
  task: string,
  out: string,
  where: { readonly home: string; readonly configHome: string },
): Promise<void> {
  const args = compileArgs(await Deno.readTextFile("deno.jsonc"), task, {
    home: where.home,
    configHome: where.configHome,
    out,
  });
  const compiled = await new Deno.Command("deno", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!compiled.success) throw new Error(`deno compile не собрал ${task}`);
}

/** Первый существующий путь из списка; ни одного — `undefined`. */
async function firstExisting(
  paths: readonly string[],
): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await Deno.stat(path);
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
    ["version", async () => {
      const outcome = await runOk(subject, ["version"]);
      assertEquals(outcome.stdout.trim(), VERSION, "не та версия");
    }],
    // Права клиента: до этой порции их не проверял никто — собранного
    // клиента прогон не запускал вовсе (`platform/monolith-removal.md`).
    // Проверяется наблюдаемым следом, а не списком флагов: основной
    // токен прочитан — значит клиент пришёл дверью человека, и ему
    // доступен её собственный метод; не прочитан — дверь была бы
    // агентской, и метода бы не было.
    ["права клиента: основной токен читается, дверь человека", async () => {
      const outcome = await runOk(subject, ["web"]);
      assert(
        outcome.stdout.startsWith("http://mpu.localhost"),
        `ссылка входа не та: ${JSON.stringify(outcome.stdout)}`,
      );
    }],
    // Клиент живёт без `PATH`: программы копирования названы в его
    // правах абсолютными путями. С именами он падал бы здесь чужим
    // текстом ещё до своей первой строки (замер 2026-09-22,
    // `cli-client.md`, «Права клиента и `PATH`»).
    ["клиент стартует без PATH в окружении", async () => {
      const outcome = await run(subject, ["version"]);
      assertEquals(outcome.stdout.trim(), VERSION, outcome.stderr);
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
        // Путь не резолвится — код 2 и с JSON: код отдаёт результат, а не
        // форма (`platform/line-grammar.md` [D.6]).
        const fromProcessEnv = await run(subject, [
          "xlsx",
          "resolve",
          GRAMMAR.close,
          "json",
        ], {
          MPU_XLSX: book,
        });
        assertEquals(fromProcessEnv.code, 2, fromProcessEnv.stderr);
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
          "text:",
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
        const node = Deno.listen({ hostname: "127.0.0.1", port: 0 });
        const envPath = `${subject.home}/.config/mpu/.env`;
        await Deno.mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(
          envPath,
          "TELEGRAM_API_ID=1\nTELEGRAM_API_HASH=проба\n" +
            `TELEGRAM_SESSION=${loopbackSession(node.addr.port)}\n`,
        );
        // Окружение достаётся серверу: строку исполняет он.
        await using server = await serve(subject, {
          HTTPS_PROXY: "http://127.0.0.1:1",
        });
        const child = new Deno.Command(subject.cli, {
          args: ["telegram", "ls", "--limit", "1"],
          env: { HOME: subject.home, MPU_BACK_URL: server.url },
          clearEnv: true,
          stdin: "null",
          stdout: "null",
          stderr: "piped",
        }).spawn();
        const stderr = new Response(child.stderr).text();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const reached = await Promise.race([
            node.accept().then((conn) => {
              conn.close();
              return "узел";
            }),
            child.status.then((status) => `завершился с ${status.code}`),
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("срок вышел"), NODE_DEADLINE_MS);
            }),
          ]);
          if (reached !== "узел") {
            // Гасить нужно только зависший: вышедший `kill` отвергает.
            if (reached === "срок вышел") child.kill("SIGKILL");
            await child.status;
            throw new Error(
              `до узла Telegram не дошёл (${reached}): ${
                (await stderr).trim()
              }`,
            );
          }
        } finally {
          clearTimeout(timer);
          try {
            child.kill("SIGKILL");
          } catch {
            // Уже завершился — гасить нечего.
          }
          await child.status;
          node.close();
          await Deno.remove(envPath);
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
        await Deno.mkdir(envPath.slice(0, envPath.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(
          envPath,
          "TELEGRAM_API_ID=1\nTELEGRAM_API_HASH=проба\n" +
            `TELEGRAM_SESSION=${loopbackSession(1)}\n` +
            "TELEGRAM_PROXY=http://127.0.0.1:1\n",
        );
        await using server = await serve(subject);
        const child = new Deno.Command(subject.cli, {
          args: ["telegram", "ls", "--limit", "1"],
          env: { HOME: subject.home, MPU_BACK_URL: server.url },
          clearEnv: true,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
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
              `за ${REFUSAL_DEADLINE_MS} мс не отказал: ${
                new TextDecoder().decode(late.stderr).trim()
              }`,
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
          await Deno.remove(envPath);
        }
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
        "file:",
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
    // Право `--allow-run` собранного бинаря: без запуска подпроцесса
    // оно осталось бы слепым — тот же класс, что правило «проверка,
    // которая ничего не утверждает» (CLAUDE.md). Годится не всякий
    // подпроцесс: `d2` в этом окружении нет вовсе, и Deno отвечает
    // «файла нет» раньше, чем спрашивает право (замер 2026-08-31 —
    // бинарь без `--allow-run` печатает ровно то же). `ssh` в PATH
    // есть, поэтому право проверяется на нём.
    ["ssh: подпроцесс запускается правом, а не отказом", async () => {
      // Ищется там же, где его будет искать бинарь: ему передаётся
      // именно этот PATH, и наличие ssh в PATH самого smoke ничего бы
      // о вызове не говорило.
      const sshBin = await firstExisting(["/usr/bin/ssh", "/bin/ssh"]);
      if (sshBin === undefined) {
        throw new Skipped("`ssh` не найден в /usr/bin и /bin: нечего звать");
      }
      const envDir = `${subject.configHome}/mpu`;
      await Deno.mkdir(envDir, { recursive: true });
      await Deno.writeTextFile(
        `${envDir}/.env`,
        // Петля с закрытым портом: ssh обязан запуститься и отказать
        // сам. Наружу вызов не идёт — ни к dev-ноде по умолчанию, ни
        // куда-либо ещё.
        "DEV_NODE_HOST=127.0.0.1\nDEV_NODE_USER=nobody\n",
      );
      try {
        const outcome = await run(subject, ["ssh", "dev:1", "echo", "hi"], {
          XDG_CONFIG_HOME: subject.configHome,
          PATH: "/usr/bin:/bin",
        });
        // Утверждение — про то, что говорит сам ssh: строка про
        // недоступный ключ приходит и когда порт закрыт, и когда на
        // машине поднят sshd (тогда отказ будет на аутентификации).
        // Привязка к «connection refused» краснела бы на машине с
        // sshd, ничего не сообщая о праве.
        assert(
          outcome.stderr.includes("Identity file") &&
            outcome.stderr.includes(".ssh/id_rsa"),
          `подпроцесс ssh не запускался: ${JSON.stringify(outcome.stderr)}`,
        );
        // Код ssh доносится как есть (`exec-transport.md`): 255 — это
        // он, а не наша трактовка. Без права бинарь падал бы с 1.
        assertEquals(outcome.code, 255, "код ssh не донесён");
      } finally {
        await Deno.remove(`${envDir}/.env`);
      }
    }],
    // Журнал вызовов: одна запись на вызов и ни одной лишней. Права на
    // файл берутся из `--allow-write=$HOME/.config/mpu` — журнал живёт
    // в каталоге состояния, а путь приходит ключом env-файла, не
    // окружением процесса (`platform/invoke-log.md`).
    ["журнал вызовов: по записи на вызов", async () => {
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
        assertEquals(resolve.code, 2, resolve.stderr);
        const afterFirst = await Deno.readTextFile(logPath);
        assertEquals(
          logRecords(afterFirst),
          [`$ mpu xlsx resolve ${GRAMMAR.close} json`],
          `не одна запись вызова: ${JSON.stringify(afterFirst)}`,
        );
        // Второй вызов — вторая запись, не больше и не меньше: пока
        // жил маршрут `legacy`, запись о его вызове делал подпроцесс, и
        // обвязка своей не добавляла. Маршрута нет, записи делает
        // только обвязка — считаем, что ровно по одной.
        await runOk(subject, ["config", "--json"]);
        const afterSecond = await Deno.readTextFile(logPath);
        assertEquals(
          logRecords(afterSecond),
          [`$ mpu xlsx resolve ${GRAMMAR.close} json`, "$ mpu config --json"],
          `записи задвоились: ${JSON.stringify(afterSecond)}`,
        );
        // Права — последним утверждением: их отсутствие у файловой
        // системы даёт пропуск (`modeOf`), и стоящее раньше он отменил
        // бы то, что от режима не зависит вовсе.
        assertEquals(
          (await modeOf(logPath)).toString(8),
          "600",
          "права файла журнала не 0600",
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
          "target:",
          "sl-1",
          "sql:",
          "SELECT 1",
          "--dry",
          "--verbose",
        ]);
        assertEquals(dry.stdout, "", "у --dry stdout обязан быть пуст");
        assertEquals(
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
    // Разбор кода собранным бинарём: `mpu code refs` строит программу
    // проекта компилятором TypeScript, запечённым в бинарь, и зовёт
    // `git` за отметкой дерева. Тесты этого не видят — они идут с
    // широкими правами; здесь права те, что зашиты задачей `build`.
    // Снять `--allow-read` или `--allow-run` — проверка краснеет:
    // первое рвёт чтение дерева, второе отметку.
    [
      "code: разбор дерева, отметка и оба раздела собранным бинарём",
      async () => {
        const ws = `${subject.home}/ws`;
        const repo = `${ws}/probe`;
        await Deno.mkdir(`${repo}/src`, { recursive: true });
        // Каталог `.git` без содержимого: репозиторием подкаталог делает
        // именно он. Отметка при этом заведомо `вне git`, и по причине,
        // которую надо назвать честно: запуск здесь идёт с `clearEnv`,
        // `PATH` в окружении бинаря нет, и `git` не запускается вовсе.
        // То есть ветка отметки под настоящим git этой проверкой НЕ
        // покрыта — её держат тесты `mark_test.ts` с подставленным
        // источником. Покрыть её здесь мешает право: пробросить `PATH`
        // можно, только прочитав его, а `--allow-env` задачи `smoke`
        // такого имени не несёт.
        await Deno.mkdir(`${repo}/.git`, { recursive: true });
        await Deno.writeTextFile(`${ws}/.mp-workspace-root`, "");
        await Deno.writeTextFile(
          `${repo}/tsconfig.json`,
          '{"compilerOptions":{"strict":true,"noEmit":true},' +
            '"include":["src/**/*"]}\n',
        );
        await Deno.writeTextFile(
          `${repo}/src/a.ts`,
          "export function addOne(n: number): number {\n  return n + 1;\n}\n",
        );
        await Deno.writeTextFile(
          `${repo}/src/b.ts`,
          "import { addOne } from './a.ts';\n\nexport const two = addOne(1);\n",
        );
        const outcome = await run(
          subject,
          ["code", "refs", "probe:src/a.ts:1"],
          {},
          repo,
        );
        assertEquals(outcome.code, 0, `stderr: ${outcome.stderr}`);
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
        // сканер компилятора: тела нормализуются им, и без прав на
        // окружение бинарь падал бы и здесь.
        const twins = await run(
          subject,
          ["code", "twins", "probe:src/a.ts:1"],
          {},
          repo,
        );
        assertEquals(twins.code, 0, `stderr: ${twins.stderr}`);
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
        await Deno.mkdir(`${other}/src`, { recursive: true });
        await Deno.mkdir(`${other}/.git`, { recursive: true });
        await Deno.writeTextFile(
          `${other}/tsconfig.json`,
          '{"compilerOptions":{"strict":true,"noEmit":true},' +
            '"include":["src/**/*"]}\n',
        );
        await Deno.writeTextFile(
          `${other}/src/c.ts`,
          "export function addOne(n: number): number {\n  return n + 2;\n}\n",
        );
        const name = await run(subject, ["code", "name", "addOne"], {}, repo);
        assertEquals(name.code, 0, `stderr: ${name.stderr}`);
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
    ["sql-ro: выброшенный sw-маршрут отказывает, а не резолвит", async () => {
      // Отказ печатает собранный бинарь: маршрута воркспейсов больше
      // нет, а алиас остаётся распознанным ради причины по делу.
      const outcome = await run(subject, [
        "sql-ro",
        "target:",
        "sw",
        "sql:",
        "SELECT 1",
      ]);
      assertEquals(outcome.code, 2, `не ошибка ввода: ${outcome.stderr}`);
      assertEquals(
        outcome.stderr,
        "mpu sql-ro: маршрут sw выброшен: доступа к контуру " +
          "воркспейсов нет\n",
      );
      assertEquals(outcome.stdout, "");
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

/**
 * Права файла восьмеричным числом. Файловая система без POSIX-прав
 * режима не сообщает — тогда пропуск, а не молчаливый проход: прежние
 * формы (`if (mode === null) return` и `mode ?? 0o600`) утверждали
 * права, ничего не проверив, а вторая ещё и сравнивала ожидаемое с
 * ожидаемым. Предмет здесь секретный — токен MCP-сервера и журнал
 * вызовов, — и вакуумно-зелёное утверждение о его правах хуже, чем
 * отсутствие утверждения: оно выглядит проверкой.
 *
 * Пропускается вся проверка целиком, а не одно утверждение: причина
 * названа дословно, и по ней видно, что именно вернула файловая
 * система.
 */
async function modeOf(path: string): Promise<number> {
  const info = await Deno.stat(path);
  if (info.mode === null) {
    throw new Skipped(
      `файловая система не сообщает права: Deno.stat(${
        JSON.stringify(path)
      }).mode === null`,
    );
  }
  return info.mode & 0o777;
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
    // `.config/mpu`: право задачи сборки перечисляет именно
    // `.config/mpu`, и запись в `xdg/mpu` им не покрыта — иначе
    // проверка границы ничего бы не доказывала.
    const subject: Subject = {
      back: `${home}/mpu-back`,
      cli: `${home}/mpu`,
      home,
      configHome: `${home}/xdg`,
    };
    console.log("== сборка ==");
    try {
      await compile(BACK_TASK, subject.back, subject);
      await compile(CLI_TASK, subject.cli, subject);
    } catch (err) {
      // Задачи нет — прогон говорит, какой именно, и уходит: падать
      // разбором незачем, а молча пропускать сборку нельзя
      // (`platform/monolith-removal.md`).
      if (!(err instanceof CompileTaskError)) throw err;
      console.error(`smoke: ${err.message}`);
      return 1;
    }
    // Человек однажды разрешил эти строки: иначе мутирующие отказали
    // бы «спросить некого». До старта сервера — см. `allowLines`.
    await Deno.mkdir(`${home}/.config/mpu`, { recursive: true });
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
    await Deno.remove(home, { recursive: true });
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
