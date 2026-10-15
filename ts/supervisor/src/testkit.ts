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

/**
 * Коммит дерева по умолчанию и коммиты, до которых его подтягивают
 * первый и второй проход установщика.
 */
export const COMMIT = "1dbb4a3a0f5e6d7c8b9a0f1e2d3c4b5a69788796";
export const LATER = "663a9e32b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6";
export const LATEST = "7cfdcca1e2d3c4b5a69788796f0e1d2c3b4a5968";

const FAKE_GIT = `#!/bin/bash
# Поддельный git: вызовы — в журнал (без глобальных -C и -c); ответы —
# окружением: ветка, вывод status, счёт своих коммитов, sha HEAD.
# Проход установщика — по числу fetch в журнале: FAKE_GIT_ORIGIN и
# FAKE_GIT_BEHIND — списки по проходам (нет k-го: origin/main прежний,
# чужих 0); merge ставит HEAD в origin/main своего прохода.
# FAKE_GIT_FAIL — какой вызов отказывает: stderr снят с git 2.47.3.
# FAKE_GIT_PULLED — строка, которую merge вписывает вторую в install.sh
# дерева новым файлом, как настоящий: так видно, чей скрипт исполняется.
# Неизвестный вызов — отказ: скрипт зовёт только перечисленное, только
# о дереве скрипта (-C на каталог с install.sh) и с путями как есть
# (core.quotePath=false: иначе не-ASCII путь — восьмеричные escape).
if [[ $1 != -C || ! -f $2/install.sh || $3 != -c || $4 != core.quotePath=false ]]; then
  echo "error: git не о дереве скрипта или без core.quotePath=false: $*" >&2
  exit 1
fi
tree=$2
shift 4
echo "$*" >>"$FAKE_GIT_LOG"
read -r -a origins <<<"\${FAKE_GIT_ORIGIN:-}"
read -r -a behinds <<<"\${FAKE_GIT_BEHIND:-}"
head=\${FAKE_GIT_HEAD:-${COMMIT}}
origin=$head
pass=0
while read -r call; do
  case $call in
    "fetch origin main")
      origin=\${origins[pass]:-$origin}
      behind=\${behinds[pass]:-0}
      pass=$((pass + 1))
      ;;
    "merge --ff-only origin/main") before=$head; head=$origin ;;
  esac
done <"$FAKE_GIT_LOG"
refuse() {
  [[ \${FAKE_GIT_FAIL:-} == "$1" ]] || return 0
  cat >&2
  exit "$2"
}
case $* in
  "rev-parse --abbrev-ref HEAD")
    # Ветка без коммитов: stdout — HEAD, причина — в stderr.
    refuse rev-parse 128 <<'ERR'
fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'
ERR
    echo "\${FAKE_GIT_BRANCH:-main}"
    ;;
  "status --porcelain --untracked-files=no")
    refuse status 128 <<'ERR'
fatal: .git/index: index file smaller than expected
ERR
    printf '%s' "\${FAKE_GIT_DIRTY:-}"
    ;;
  "fetch origin main")
    # Remote, которого нет.
    refuse fetch 128 <<'ERR'
fatal: 'origin' does not appear to be a git repository
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
ERR
    ;;
  "rev-list --left-right --count HEAD...origin/main")
    # origin/main, которого нет.
    refuse rev-list 128 <<'ERR'
fatal: ambiguous argument 'HEAD...origin/main': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'
ERR
    printf '%s\\t%s\\n' "\${FAKE_GIT_AHEAD:-0}" "$behind"
    ;;
  # Подтянуто — от коммита до слияния, не от origin/main.
  "rev-list --count \${before:0:7}..HEAD") echo "$behind" ;;
  "merge --ff-only origin/main")
    # Мешает неотслеживаемый файл: метки fatal: нет.
    refuse merge-untracked 1 <<'ERR'
error: The following untracked working tree files would be overwritten by merge:
\tx
Please move or remove them before you merge.
Aborting
ERR
    # Ветви разошлись между счётом и слиянием.
    refuse merge 128 <<'ERR'
hint: Diverging branches can't be fast-forwarded, you need to either:
hint:
hint: \tgit merge --no-ff
hint:
hint: or:
hint:
hint: \tgit rebase
hint:
hint: Disable this message with "git config advice.diverging false"
fatal: Not possible to fast-forward, aborting.
ERR
    if [[ -n \${FAKE_GIT_PULLED:-} ]]; then
      { head -n 1 "$tree/install.sh"; echo "$FAKE_GIT_PULLED"; tail -n +2 "$tree/install.sh"; } >"$tree/install.sh.new"
      mv "$tree/install.sh.new" "$tree/install.sh"
    fi
    echo "Fast-forward"
    ;;
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
      // Метка второго прохода у запускающего сделала бы первый вторым.
      MPU_INSTALL_RERUN: "",
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
