/**
 * Оснастка прогонов `ts/install.sh`
 * (`platform/supervisor-install.md`, `platform/cutover.md`): всё во
 * временных каталогах, исходники — поддельным `git` (`MPU_GIT`), сверка
 * зависимостей и сборка — поддельным `bun` (`MPU_BUN`), служба —
 * поддельным `systemctl`, каталог настроек nu — поддельным `nu`
 * (`MPU_NU`), проверки против серверов, поднятых тестом.
 * Настоящие `~/.local/bin`, служба пользователя, `systemctl` и файлы
 * настроек оболочек не трогаются.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { text } from "node:stream/consumers";

export const ROOT = new URL("../../", import.meta.url).pathname;

const FAKE_BUN = `#!/bin/bash
# Поддельный bun: вызовы — в журнал. Сверка зависимостей —
# \`bun install --frozen-lockfile\`: FAKE_BUN_INSTALL=fail — отказ
# выводом, снятым с bun 1.4.2 при package.json, разошедшемся с bun.lock.
# Сборка — исполняемый скрипт с --version и version, зовут её только
# скриптом package.json: \`bun run compile:<часть>\`.
echo "$*" >>"$FAKE_BUN_LOG"
if [[ $* == "install --frozen-lockfile" ]]; then
  # Сверяется дерево скрипта, а не каталог запускающего.
  if [[ ! -f install.sh ]]; then
    echo "error: bun install не в дереве скрипта: $PWD" >&2
    exit 1
  fi
  echo "bun install v1.4.2 (744846f84)"
  [[ \${FAKE_BUN_INSTALL:-} == fail ]] || exit 0
  cat >&2 <<'OUT'
Resolving dependencies
Resolved, downloaded and extracted [2]
error: lockfile had changes, but lockfile is frozen
note: try re-running without --frozen-lockfile and commit the updated lockfile
OUT
  exit 1
fi
if [[ $1 != run || $2 != compile:* ]]; then
  echo "error: ждали bun run compile:<часть>, пришло: $*" >&2
  exit 1
fi
part=\${2#compile:}
if [[ \${FAKE_FAIL:-} == "$part" ]]; then
  echo "error: сборка сломана" >&2
  exit 1
fi
tag_var="FAKE_TAG_$part"
if [[ $part == web ]]; then
  mkdir -p "$MPU_OUT/assets"
  echo "<html>\${!tag_var:-1}</html>" >"$MPU_OUT/index.html"
  echo "console.log(1)" >"$MPU_OUT/assets/app.js"
  exit 0
fi
cat >"$MPU_OUT" <<SCRIPT
#!/bin/bash
# $part \${!tag_var:-1}
if [[ \\$1 == --version || \\$1 == version ]]; then echo 0.1.0; exit 0; fi
if [[ \\$1 == init ]]; then
  echo "# дополнение \\$2 для mpu"
  # Отпечаток настоящего скрипта: обратные слэши в теле
  # (у bash — IFS, у nu — split column), на которых ломается
  # передача тела в awk через -v.
  cat <<'BODY'
local IFS=$'\\n'
split column "\\t"
BODY
  exit 0
fi
exit 3
SCRIPT
chmod +x "$MPU_OUT"
`;

const FAKE_SYSTEMCTL = `#!/bin/bash
# Поддельный systemctl: вызовы — в журнал, активность — файлом;
# перезапуск части — строка в её файле: фальшивый сервер по ней сменит pid.
echo "$*" >>"$FAKE_LOG"
case $2 in
  is-active) [[ -e $FAKE_STATE ]] ;;
  start) touch "$FAKE_STATE" ;;
  restart) touch "$FAKE_STATE"; echo x >>"$FAKE_MARK/back"; echo x >>"$FAKE_MARK/mcp" ;;
  kill)
    [[ $* == *USR1* ]] && echo x >>"$FAKE_MARK/back"
    [[ $* == *USR2* ]] && echo x >>"$FAKE_MARK/mcp"
    true
    ;;
esac
`;

const FAKE_CLAUDE = `#!/bin/bash
# Поддельный claude: вызовы — в журнал; серверы пользователя — в
# $HOME/.claude.json, как у настоящего. Имя занято — отказ, как у него.
echo "$*" >>"$FAKE_CLAUDE_LOG"
file=$HOME/.claude.json
[[ -f $file ]] || echo '{}' >"$file"
case "$1 $2" in
  "mcp add-json")
    jq -e --arg n "$5" '.mcpServers[$n]' "$file" >/dev/null && exit 1
    jq --arg n "$5" --argjson s "$6" '.mcpServers[$n] = $s' "$file" >"$file.new"
    ;;
  "mcp remove") jq --arg n "$5" 'del(.mcpServers[$n])' "$file" >"$file.new" ;;
  *) exit 3 ;;
esac
mv "$file.new" "$file"
`;

/** Коммит дерева по умолчанию и коммит, до которого его подтягивают. */
export const COMMIT = "1dbb4a3a0f5e6d7c8b9a0f1e2d3c4b5a69788796";
export const LATER = "663a9e32b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6";

const FAKE_GIT = `#!/bin/bash
# Поддельный git: вызовы — в журнал (без глобальных -C и -c); ответы —
# окружением: ветка, вывод status, отказ fetch, счёт своих и чужих
# коммитов, sha HEAD и origin/main. После merge HEAD — sha origin/main.
# Неизвестный вызов — отказ: скрипт зовёт только перечисленное, и
# только о дереве скрипта (-C на каталог с install.sh).
if [[ $1 != -C || ! -f $2/install.sh ]]; then
  echo "error: git не о дереве скрипта: $*" >&2
  exit 1
fi
while [[ $1 == -C || $1 == -c ]]; do shift 2; done
echo "$*" >>"$FAKE_GIT_LOG"
before=\${FAKE_GIT_HEAD:-${COMMIT}}
origin=\${FAKE_GIT_ORIGIN:-$before}
head=$before
grep -qx 'merge --ff-only origin/main' "$FAKE_GIT_LOG" && head=$origin
case $* in
  "rev-parse --abbrev-ref HEAD") echo "\${FAKE_GIT_BRANCH:-main}" ;;
  "status --porcelain --untracked-files=no") printf '%s' "\${FAKE_GIT_DIRTY:-}" ;;
  "fetch origin main")
    [[ \${FAKE_GIT_FETCH:-} == fail ]] || exit 0
    # Снято с git 2.47.3: remote, которого нет.
    cat >&2 <<'ERR'
fatal: '/nonexistent/repo' does not appear to be a git repository
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
ERR
    exit 128
    ;;
  "rev-list --left-right --count HEAD...origin/main")
    printf '%s\\t%s\\n' "\${FAKE_GIT_AHEAD:-0}" "\${FAKE_GIT_BEHIND:-0}"
    ;;
  # Подтянуто — от коммита до слияния, не от origin/main.
  "rev-list --count \${before:0:7}..HEAD") echo "\${FAKE_GIT_BEHIND:-0}" ;;
  "merge --ff-only origin/main") echo "Fast-forward" ;;
  "rev-parse --short=7 HEAD") echo "\${head:0:7}" ;;
  *)
    echo "error: поддельный git не знает вызова: $*" >&2
    exit 1
    ;;
esac
`;

const FAKE_NU = `#!/bin/bash
# Поддельный nu: каталог настроек — во временном XDG_CONFIG_HOME,
# как у настоящего; прочие вызовы установщику не нужны.
[[ $* == *default-config-dir* ]] || exit 3
echo "\${XDG_CONFIG_HOME:-$HOME/.config}/nushell"
`;

/** Сколько ответов после перезапуска ещё отвечает старый процесс. */
const OLD_ANSWERS = 3;

/**
 * Фальшивая часть службы: /health с pid; после строки в файле пометок
 * ещё несколько ответов — старый pid, затем новый.
 */
async function fakePart(mark: string, base: number, extra: object) {
  let generation = 0;
  let lag = 0;
  const seen = { newPid: false };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/mcp") {
      response.statusCode = 401;
      return response.end();
    }
    if (path !== "/health") {
      response.statusCode = 404;
      return response.end();
    }
    let marks = 0;
    try {
      marks = readFileSync(mark, "utf8").split("\n").length - 1;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        throw err;
      }
    }
    if (marks > generation && lag < OLD_ANSWERS) {
      lag += 1;
    } else if (marks > generation) {
      generation = marks;
      lag = 0;
      seen.newPid = true;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ ok: true, ...extra, pid: base + generation }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`адрес петли не порт: ${address}`);
  }
  return { server, seen, url: `http://127.0.0.1:${address.port}` };
}

/** Остановка фальшивой части: соединения — сразу, иначе `close` ждёт их. */
function stopped(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

export interface Place {
  readonly dir: string;
  readonly back: Awaited<ReturnType<typeof fakePart>>;
  readonly mcp: Awaited<ReturnType<typeof fakePart>>;
  readonly bin: string;
  readonly unit: string;
  readonly calls: string;
}

export async function withPlace(body: (place: Place) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-install-"));
  const back = await fakePart(`${dir}/back`, 100, { version: "0.1.0" });
  const mcp = await fakePart(`${dir}/mcp`, 200, {});
  try {
    await writeFile(`${dir}/bun`, FAKE_BUN, { mode: 0o755 });
    await writeFile(`${dir}/systemctl`, FAKE_SYSTEMCTL, { mode: 0o755 });
    await writeFile(`${dir}/claude`, FAKE_CLAUDE, { mode: 0o755 });
    await writeFile(`${dir}/nu`, FAKE_NU, { mode: 0o755 });
    await writeFile(`${dir}/git`, FAKE_GIT, { mode: 0o755 });
    await body({
      dir,
      back,
      mcp,
      bin: `${dir}/bin`,
      unit: `${dir}/unit`,
      calls: `${dir}/calls`,
    });
  } finally {
    await stopped(back.server);
    await stopped(mcp.server);
    await rm(dir, { recursive: true });
  }
}

export interface Run {
  readonly code: number;
  readonly lines: string[];
  /** Вызовы `systemctl`, кроме опроса активности. */
  readonly calls: string[];
  /** Вызовы `claude`. */
  readonly claude: string[];
  /** Вызовы `git`, без глобальных `-C` и `-c`. */
  readonly git: string[];
  /** Вызовы `bun`: сверка зависимостей и сборка. */
  readonly bun: string[];
}

export async function runScript(
  place: Place,
  script: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
  /** Откуда и чем звать: дерево и рабочий каталог вызывающего. */
  where: { readonly tree?: string; readonly from?: string } = {},
): Promise<Run> {
  const tree = where.tree ?? ROOT;
  await writeFile(place.calls, "");
  const claudeLog = `${place.dir}/claude-calls`;
  await writeFile(claudeLog, "");
  const gitLog = `${place.dir}/git-calls`;
  await writeFile(gitLog, "");
  const bunLog = `${place.dir}/bun-calls`;
  await writeFile(bunLog, "");
  const output = await ran("/bin/bash", [`${tree}${script}`, ...args], {
    cwd: where.from ?? ROOT,
    // Окружение запускающего — под подменами: прежний запуск сливал
    // `env` с ним, `spawn` его заменяет.
    env: {
      ...process.env,
      HOME: place.dir,
      // Каталог настроек — во временном HOME: без этого fish и nu
      // указали бы на настоящие файлы запускающего.
      XDG_CONFIG_HOME: `${place.dir}/config`,
      MPU_BIN_DIR: place.bin,
      MPU_UNIT_DIR: place.unit,
      MPU_SYSTEMCTL: `${place.dir}/systemctl`,
      MPU_BUN: `${place.dir}/bun`,
      // Настоящее дерево — не main и не в сети: без подмены исход
      // зависел бы от ветки и состояния репозитория запускающего.
      MPU_GIT: `${place.dir}/git`,
      FAKE_GIT_LOG: gitLog,
      FAKE_BUN_LOG: bunLog,
      MPU_CLAUDE: `${place.dir}/claude`,
      // Настоящий nu запускающего тестам не виден: без подмены исход
      // зависел бы от того, стоит ли nu на машине.
      MPU_NU: `${place.dir}/nu`,
      FAKE_CLAUDE_LOG: claudeLog,
      MPU_WEB_DIR: `${place.dir}/web`,
      MPU_BACK_URL: place.back.url,
      MPU_MCP_URL: place.mcp.url,
      FAKE_MARK: place.dir,
      FAKE_LOG: place.calls,
      FAKE_STATE: `${place.dir}/active`,
      ...env,
    },
  });
  const printed = output.stdout + output.stderr;
  const calls = (await readFile(place.calls, "utf8"))
    .split("\n")
    .filter((call) => call !== "" && !call.includes("is-active"));
  return {
    code: output.code,
    lines: printed.split("\n").filter((line) => line !== ""),
    calls,
    claude: await journal(claudeLog),
    git: await journal(gitLog),
    bun: await journal(bunLog),
  };
}

/** Журнал вызовов поддельной программы: строка — вызов. */
async function journal(path: string): Promise<string[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((call) => call !== "");
}

/** Каталог: имя файла → sha256 содержимого. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  try {
    for (const name of await readdir(dir)) {
      const bytes = await readFile(`${dir}/${name}`);
      files[name] = createHash("sha256").update(bytes).digest("hex");
    }
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
      throw err;
    }
  }
  return files;
}

/** Итог программы: код и оба потока текстом. */
async function ran(
  program: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(program, [...args], {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const [stdout, stderr, code] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    exited,
  ]);
  // Убит сигналом — кода нет; для прогона скрипта это провал.
  return { code: code ?? 1, stdout, stderr };
}
