/**
 * `ts/install.sh` (`platform/supervisor-install.md`): всё во временных
 * каталогах, сборка — поддельным `deno` (`MPU_DENO`), служба — поддельным
 * `systemctl`, проверки шага 7 — против серверов, поднятых тестом.
 * Настоящие `~/.local/bin`, служба пользователя и `systemctl` не
 * трогаются.
 */

import { assertEquals } from "@std/assert";

const ROOT = new URL("../../", import.meta.url).pathname;

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

interface Place {
  readonly dir: string;
  readonly back: ReturnType<typeof fakePart>;
  readonly mcp: ReturnType<typeof fakePart>;
  readonly bin: string;
  readonly unit: string;
  readonly calls: string;
}

async function withPlace(body: (place: Place) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const back = fakePart(`${dir}/back`, 100, { version: "0.1.0" });
  const mcp = fakePart(`${dir}/mcp`, 200, {});
  try {
    await Deno.writeTextFile(`${dir}/deno`, FAKE_DENO, { mode: 0o755 });
    await Deno.writeTextFile(`${dir}/systemctl`, FAKE_SYSTEMCTL, {
      mode: 0o755,
    });
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

interface Run {
  readonly code: number;
  readonly lines: string[];
  /** Вызовы `systemctl`, кроме опроса активности. */
  readonly calls: string[];
}

async function install(
  place: Place,
  args: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<Run> {
  await Deno.writeTextFile(place.calls, "");
  const output = await new Deno.Command("/bin/bash", {
    args: ["install.sh", ...args],
    cwd: ROOT,
    env: {
      HOME: place.dir,
      MPU_BIN_DIR: place.bin,
      MPU_UNIT_DIR: place.unit,
      MPU_SYSTEMCTL: `${place.dir}/systemctl`,
      MPU_DENO: `${place.dir}/deno`,
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
  return {
    code: output.code,
    lines: text.split("\n").filter((line) => line !== ""),
    calls,
  };
}

/** Каталог: имя файла → sha256 содержимого. */
async function snapshot(dir: string): Promise<Record<string, string>> {
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

const PROGRAMS = [
  "mpu-back",
  "mpu-complete",
  "mpu-mcp",
  "mpu-next",
  "mpu-supervisor",
];

Deno.test("первая установка: всё собрано и поставлено, служба — эталон, start", () =>
  withPlace(async (place) => {
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(Object.keys(await snapshot(place.bin)).sort(), PROGRAMS);
    assertEquals(
      await Deno.readTextFile(`${place.unit}/mpu-next.service`),
      await Deno.readTextFile(
        new URL(
          "testdata/supervisor-install/mpu-next.service",
          import.meta.url,
        ),
      ),
    );
    assertEquals(run.calls, [
      "--user daemon-reload",
      "--user enable mpu-next",
      "--user start mpu-next",
    ]);
    assertEquals(run.lines.every((line) => line.startsWith("install: ")), true);
    assertEquals(run.lines.at(-1), "install: готово");
  }));

Deno.test("второй запуск без изменений: ничего не ставится и не перезапускается", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(
      run.lines.filter((line) => line.includes("сравнение")),
      ["back", "mcp", "cli", "supervisor", "complete", "web"].map((part) =>
        `install: сравнение ${part}: без изменений`
      ),
    );
    assertEquals(run.calls, []);
    assertEquals(await snapshot(place.bin), before);
    assertEquals(run.lines.at(-1), "install: готово");
  }));

Deno.test("--only mcp после правки: только mpu-mcp и USR2 главному процессу", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, ["--only", "mcp"], { FAKE_TAG_mcp: "2" });
    assertEquals(run.code, 0, run.lines.join("\n"));
    const after = await snapshot(place.bin);
    for (const program of PROGRAMS) {
      assertEquals(
        after[program] === before[program],
        program !== "mpu-mcp",
        program,
      );
    }
    assertEquals(run.calls, ["--user kill --kill-whom=main -s USR2 mpu-next"]);
    const both = await install(place, ["--only", "back,mcp"], {
      FAKE_TAG_back: "3",
      FAKE_TAG_mcp: "3",
    });
    assertEquals(both.calls, [
      "--user kill --kill-whom=main -s USR1 mpu-next",
      "--user kill --kill-whom=main -s USR2 mpu-next",
    ]);
  }));

Deno.test("сборка упала: ошибка шага, код 1, каталог программ не тронут", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, [], {
      FAKE_FAIL: "back",
      FAKE_TAG_mcp: "9",
    });
    assertEquals(run.code, 1);
    assertEquals(
      run.lines.at(-1),
      "install: сборка back: ошибка: error: сборка сломана",
    );
    assertEquals(await snapshot(place.bin), before);
    assertEquals(run.calls, []);
  }));

Deno.test("--check: код 0, каталоги программ и службы без изменений", () =>
  withPlace(async (place) => {
    const empty = await install(place, ["--check"]);
    assertEquals(empty.code, 0, empty.lines.join("\n"));
    assertEquals(await snapshot(place.bin), {});
    assertEquals(await snapshot(place.unit), {});
    await install(place);
    const bin = await snapshot(place.bin);
    const unit = await snapshot(place.unit);
    const run = await install(place, ["--check"], { FAKE_TAG_back: "5" });
    assertEquals(run.code, 0);
    assertEquals(
      run.lines.includes("install: сравнение back: изменилось"),
      true,
    );
    assertEquals(await snapshot(place.bin), bin);
    assertEquals(await snapshot(place.unit), unit);
    assertEquals(run.calls, []);
  }));

Deno.test("старое не упоминается и не трогается: ни программа mpu, ни её служба, ни 7337", async () => {
  const texts = [await Deno.readTextFile(`${ROOT}install.sh`)];
  for await (const entry of Deno.readDir(`${ROOT}supervisor/src`)) {
    if (entry.isFile && !entry.name.endsWith("_test.ts")) {
      texts.push(
        await Deno.readTextFile(`${ROOT}supervisor/src/${entry.name}`),
      );
    }
  }
  texts.push(await Deno.readTextFile(`${ROOT}supervisor/main.ts`));
  for (const text of texts) {
    assertEquals(/\.local\/bin\/mpu(?![-\w])/.test(text), false);
    assertEquals(text.includes("mpu-mcp.service"), false);
    assertEquals(text.includes("7337"), false);
  }
  await withPlace(async (place) => {
    const run = await install(place);
    for (const call of run.calls) {
      assertEquals(call.includes("mpu-mcp"), false, call);
    }
  });
});

Deno.test("--only с неизвестной частью — ошибка аргументов, ничего не собрано", () =>
  withPlace(async (place) => {
    const run = await install(place, ["--only", "back,nope"]);
    assertEquals(run.code, 1);
    assertEquals(run.lines, ["install: аргументы: ошибка: нет части nope"]);
    assertEquals(await snapshot(place.bin), {});
    assertEquals(run.calls, []);
  }));

Deno.test("после перезапуска проверка ждёт ответа нового процесса (другой pid)", () =>
  withPlace(async (place) => {
    await install(place);
    const run = await install(place, ["--only", "back,mcp"], {
      FAKE_TAG_back: "7",
      FAKE_TAG_mcp: "7",
    });
    assertEquals(run.code, 0, run.lines.join("\n"));
    // Старый процесс ещё отвечал: установка не засчитала его ответ.
    assertEquals(place.back.seen.newPid, true);
    assertEquals(place.mcp.seen.newPid, true);
  }));

Deno.test("--only complete: поставлен только mpu-complete, без службы и сигналов", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, ["--only", "complete"], {
      FAKE_TAG_complete: "2",
    });
    assertEquals(run.code, 0, run.lines.join("\n"));
    const after = await snapshot(place.bin);
    for (const program of PROGRAMS) {
      assertEquals(
        after[program] === before[program],
        program !== "mpu-complete",
        program,
      );
    }
    assertEquals(run.calls, []);
    assertEquals(run.lines.at(-1), "install: готово");
  }));

Deno.test("фронт: каталог web/<хэш>/ и ссылка current, без службы; прежняя сборка остаётся", () =>
  withPlace(async (place) => {
    await install(place);
    const web = `${place.dir}/web`;
    const first = await Deno.readLink(`${web}/current`);
    assertEquals(/^[0-9a-f]{64}$/.test(first), true, first);
    assertEquals(
      await Deno.readTextFile(`${web}/current/index.html`),
      "<html>1</html>\n",
    );
    const same = await install(place, ["--only", "web"]);
    assertEquals(
      same.lines.includes("install: сравнение web: без изменений"),
      true,
    );
    const run = await install(place, ["--only", "web"], { FAKE_TAG_web: "2" });
    assertEquals(run.code, 0, run.lines.join("\n"));
    const second = await Deno.readLink(`${web}/current`);
    assertEquals(second === first, false);
    assertEquals(
      await Deno.readTextFile(`${web}/current/index.html`),
      "<html>2</html>\n",
    );
    assertEquals((await Deno.stat(`${web}/${first}`)).isDirectory, true);
    // Только фронт изменился — служба не трогается.
    assertEquals(run.calls, []);
  }));
