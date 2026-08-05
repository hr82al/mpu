/**
 * `deno task smoke` — проверка собранного бинаря на том, чего не видит
 * `deno test`: на правах, зашитых в него при `deno compile`. Тесты идут
 * с широким набором прав, поэтому нехватка `--allow-*` в задаче `build`
 * их не краснит — она видна только запуску самого бинаря.
 *
 * Бинарь собирается во временный каталог, и он же служит ему HOME:
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
import { WARMUP_BUDGET_MS } from "../src/init/kaiten.ts";

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

/** Собранный бинарь и каталог, который служит ему домашним. */
interface Subject {
  readonly bin: string;
  readonly home: string;
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
 * бинарь ставится. Подменяются только путь вывода и HOME.
 */
function buildArgs(denoJsonc: string, subject: Subject): string[] {
  const task = denoJsonc.match(/"build":\s*"([^"]*)"/)?.[1];
  if (task === undefined) throw new Error("в deno.jsonc нет задачи build");
  const args = task.split(/\s+/).slice(1).map((arg) =>
    arg.replaceAll("$HOME", subject.home)
  );
  const out = args.indexOf("-o");
  if (out < 0) throw new Error("в задаче build нет -o");
  args[out + 1] = subject.bin;
  return args;
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
      for (const [shell, rc] of [["bash", ".bashrc"], ["zsh", ".zshrc"]]) {
        await runOk(subject, ["--install-completion", shell]);
        const text = await Deno.readTextFile(`${subject.home}/${rc}`);
        assert(text.includes("_mpu_completion"), `скрипт не дописан в ${rc}`);
      }
    }],
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
      const server = Deno.serve(
        { port: 0, hostname: "127.0.0.1", onListen: () => {} },
        (req) => {
          const url = new URL(req.url);
          if (url.pathname === "/api/endpoints") {
            return Response.json([{ Id: 1, Name: "prod" }]);
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
        // на запись в конфиг-каталог для нового файла.
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
    ["маршрут legacy", async () => {
      const outcome = await runOk(subject, ["search", "--help"]);
      assert(
        outcome.stdout.includes("legacy-ok"),
        `подпроцесс не отработал: ${JSON.stringify(outcome.stdout)}`,
      );
    }],
    // Журнал вызовов: одна запись на вызов и ни одной лишней. Права на
    // файл берутся из `--allow-write=$HOME/.config/mpu` — журнал живёт
    // в конфиг-каталоге, а путь приходит ключом env-файла, не
    // окружением процесса (`platform/invoke-log.md`).
    ["журнал вызовов: по записи на вызов, legacy пишет сам", async () => {
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

        await runOk(subject, ["search", "--help"]);
        const afterLegacy = await Deno.readTextFile(logPath);
        // Вторая запись — от подпроцесса; обвязка для маршрута `legacy`
        // своей не делает, иначе записей было бы три.
        assertEquals(
          logRecords(afterLegacy),
          ["$ mpu xlsx resolve --json", "$ mpu search --help"],
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
    ["mcp: сокет, токен, аннотации тулов", () => checkMcpServer(subject)],
  ];
}

async function main(): Promise<number> {
  const home = await Deno.makeTempDir({ prefix: "mpu-smoke-" });
  try {
    const subject: Subject = { bin: `${home}/mpu`, home };
    console.log("== сборка ==");
    await compile(subject);
    await installFakeLegacy(subject);
    console.log("== проверки ==");
    let failed = 0;
    for (const [name, check] of checks(subject)) {
      try {
        await check();
        console.log(`  ok   ${name}`);
      } catch (err) {
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
    console.log("smoke: бинарь рабочий");
    return 0;
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
