/**
 * Оснастка прогонов `ts/install.sh`
 * (`platform/supervisor-install.md`, `platform/cutover.md`): всё во
 * временных каталогах, сборка — поддельным `deno` (`MPU_DENO`), служба —
 * поддельным `systemctl`, проверки против серверов, поднятых тестом.
 * Настоящие `~/.local/bin`, служба пользователя, `systemctl` и файлы
 * настроек оболочек не трогаются.
 */

export const ROOT = new URL("../../", import.meta.url).pathname;

const FAKE_DENO = `#!/bin/bash
# Поддельная сборка: исполняемый скрипт с --version и version.
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

/** Сколько ответов после перезапуска ещё отвечает старый процесс. */
const OLD_ANSWERS = 3;

/**
 * Фальшивая часть службы: /health с pid; после строки в файле пометок
 * ещё несколько ответов — старый pid, затем новый.
 */
function fakePart(mark: string, base: number, extra: object) {
  let generation = 0;
  let lag = 0;
  const seen = { newPid: false };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (
    request,
  ) => {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") return new Response(null, { status: 401 });
    if (path !== "/health") return new Response(null, { status: 404 });
    let marks = 0;
    try {
      marks = Deno.readTextFileSync(mark).split("\n").length - 1;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    if (marks > generation && lag < OLD_ANSWERS) {
      lag += 1;
    } else if (marks > generation) {
      generation = marks;
      lag = 0;
      seen.newPid = true;
    }
    return Response.json({ ok: true, ...extra, pid: base + generation });
  });
  return { server, seen, url: `http://127.0.0.1:${server.addr.port}` };
}

export interface Place {
  readonly dir: string;
  readonly back: ReturnType<typeof fakePart>;
  readonly mcp: ReturnType<typeof fakePart>;
  readonly bin: string;
  readonly unit: string;
  readonly calls: string;
}

export async function withPlace(body: (place: Place) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const back = fakePart(`${dir}/back`, 100, { version: "0.1.0" });
  const mcp = fakePart(`${dir}/mcp`, 200, {});
  try {
    await Deno.writeTextFile(`${dir}/deno`, FAKE_DENO, { mode: 0o755 });
    await Deno.writeTextFile(`${dir}/systemctl`, FAKE_SYSTEMCTL, {
      mode: 0o755,
    });
    await Deno.writeTextFile(`${dir}/claude`, FAKE_CLAUDE, { mode: 0o755 });
    await body({
      dir,
      back,
      mcp,
      bin: `${dir}/bin`,
      unit: `${dir}/unit`,
      calls: `${dir}/calls`,
    });
  } finally {
    await back.server.shutdown();
    await mcp.server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

export interface Run {
  readonly code: number;
  readonly lines: string[];
  /** Вызовы `systemctl`, кроме опроса активности. */
  readonly calls: string[];
  /** Вызовы `claude`. */
  readonly claude: string[];
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
  await Deno.writeTextFile(place.calls, "");
  const claudeLog = `${place.dir}/claude-calls`;
  await Deno.writeTextFile(claudeLog, "");
  const output = await new Deno.Command("/bin/bash", {
    args: [`${tree}${script}`, ...args],
    cwd: where.from ?? ROOT,
    env: {
      HOME: place.dir,
      // Каталог настроек — во временном HOME: без этого fish и nu
      // указали бы на настоящие файлы запускающего.
      XDG_CONFIG_HOME: `${place.dir}/config`,
      MPU_BIN_DIR: place.bin,
      MPU_UNIT_DIR: place.unit,
      MPU_SYSTEMCTL: `${place.dir}/systemctl`,
      MPU_DENO: `${place.dir}/deno`,
      MPU_CLAUDE: `${place.dir}/claude`,
      FAKE_CLAUDE_LOG: claudeLog,
      MPU_WEB_DIR: `${place.dir}/web`,
      MPU_BACK_URL: place.back.url,
      MPU_MCP_URL: place.mcp.url,
      FAKE_MARK: place.dir,
      FAKE_LOG: place.calls,
      FAKE_STATE: `${place.dir}/active`,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stdout) +
    new TextDecoder().decode(output.stderr);
  const calls = (await Deno.readTextFile(place.calls)).split("\n")
    .filter((call) => call !== "" && !call.includes("is-active"));
  const claude = (await Deno.readTextFile(claudeLog)).split("\n")
    .filter((call) => call !== "");
  return {
    code: output.code,
    lines: text.split("\n").filter((line) => line !== ""),
    calls,
    claude,
  };
}

/** Каталог: имя файла → sha256 содержимого. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  try {
    for await (const entry of Deno.readDir(dir)) {
      const bytes = await Deno.readFile(`${dir}/${entry.name}`);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      files[entry.name] = Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return files;
}
