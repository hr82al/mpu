/**
 * `ts/install.sh` (`platform/supervisor-install.md`, `platform/cutover.md`):
 * сборка поддельным `deno`, служба поддельным `systemctl`, файлы настроек
 * оболочек — во временном `HOME`. Оснастка — `testkit.ts`.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  type Place,
  ROOT,
  type Run,
  runScript,
  snapshot,
  withPlace,
} from "./testkit.ts";

/** Прогон установщика. */
function install(
  place: Place,
  args: readonly string[] = [],
  env: Record<string, string> = {},
  where: { readonly tree?: string; readonly from?: string } = {},
): Promise<Run> {
  return runScript(place, "install.sh", args, env, where);
}

const PROGRAMS = [
  "mpu",
  "mpu-back",
  "mpu-complete",
  "mpu-mcp",
  "mpu-supervisor",
  "mpu-worker",
];

Deno.test("первая установка: всё собрано и поставлено, служба — эталон, start", () =>
  withPlace(async (place) => {
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(Object.keys(await snapshot(place.bin)).sort(), PROGRAMS);
    assertEquals(
      await Deno.readTextFile(`${place.unit}/mpu.service`),
      await Deno.readTextFile(
        new URL(
          "testdata/supervisor-install/mpu.service",
          import.meta.url,
        ),
      ),
    );
    assertEquals(run.calls, [
      "--user daemon-reload",
      "--user enable mpu",
      "--user start mpu",
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
      ["back", "worker", "mcp", "cli", "supervisor", "complete", "web"].map((
        part,
      ) => `install: сравнение ${part}: без изменений`),
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
    assertEquals(run.calls, ["--user kill --kill-whom=main -s USR2 mpu"]);
    const both = await install(place, ["--only", "back,mcp"], {
      FAKE_TAG_back: "3",
      FAKE_TAG_mcp: "3",
    });
    assertEquals(both.calls, [
      "--user kill --kill-whom=main -s USR1 mpu",
      "--user kill --kill-whom=main -s USR2 mpu",
    ]);
  }));

Deno.test("--only worker после правки: только mpu-worker и USR1 — исполнителей берёт новое ядро", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, ["--only", "worker"], {
      FAKE_TAG_worker: "2",
    });
    assertEquals(run.code, 0, run.lines.join("\n"));
    const after = await snapshot(place.bin);
    for (const program of PROGRAMS) {
      assertEquals(
        after[program] === before[program],
        program !== "mpu-worker",
        program,
      );
    }
    assertEquals(run.calls, ["--user kill --kill-whom=main -s USR1 mpu"]);
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

Deno.test("старая служба рядом: отказ до установки службы, с подсказкой", () =>
  withPlace(async (place) => {
    for (const old of ["mpu-mcp.service", "mpu-next.service"]) {
      await Deno.mkdir(place.unit, { recursive: true });
      await Deno.writeTextFile(`${place.unit}/${old}`, "[Unit]\n");
      const run = await install(place);
      assertEquals(run.code, 1);
      assertEquals(
        run.lines.at(-1),
        `install: служба: ошибка: рядом старая служба ${old}, ` +
          `снимите её: systemctl --user disable --now ${
            old.slice(0, -".service".length)
          }`,
      );
      // Ни служба не поставлена, ни программы: отказ приходит до
      // сборки, и машина не остаётся наполовину переключённой.
      assertEquals(Object.keys(await snapshot(place.unit)), [old]);
      assertEquals(await snapshot(place.bin), {});
      assertEquals(run.calls, []);
      await Deno.remove(`${place.unit}/${old}`);
    }
  }));

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

/** Файл настроек оболочки во временном HOME. */
async function shellConfig(place: Place, shell: string, text: string) {
  const paths: Record<string, string> = {
    bash: `${place.dir}/.bashrc`,
    fish: `${place.dir}/config/fish/config.fish`,
    nu: `${place.dir}/config/nushell/config.nu`,
  };
  const path = paths[shell];
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, text);
  return path;
}

/** Что печатает подставной `mpu-complete init` — тело блока. */
function fakeBody(shell: string): string {
  return [
    `# дополнение ${shell} для mpu`,
    "local IFS=$'\\n'",
    'split column "\\t"',
  ].join("\n");
}

const BEGIN = "# >>> mpu completion >>>";
const END = "# <<< mpu completion <<<";

/** Строки между маркерами; блока нет — пусто. */
function blocks(text: string): string[] {
  const found: string[] = [];
  let inside: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line === BEGIN) {
      inside = [];
      continue;
    }
    if (line === END && inside !== undefined) {
      found.push(inside.join("\n"));
      inside = undefined;
      continue;
    }
    inside?.push(line);
  }
  return found;
}

Deno.test("дополнение: блок в каждой настроенной оболочке, прочие — не настроены", () =>
  withPlace(async (place) => {
    const bashrc = await shellConfig(place, "bash", "export PS1='$ '\n");
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(
      run.lines.filter((line) => line.startsWith("install: дополнение")),
      [
        "install: дополнение bash: подключено",
        "install: дополнение fish: не настроена",
        "install: дополнение nu: не настроена",
      ],
    );
    const text = await Deno.readTextFile(bashrc);
    assertEquals(blocks(text), [fakeBody("bash")]);
    // Текст человека остался на месте.
    assertEquals(text.startsWith("export PS1='$ '\n"), true);
  }));

Deno.test("дополнение: три прогона — один блок, чужой текст не тронут", () =>
  withPlace(async (place) => {
    const before = "export PS1='$ '\n# хвост человека\n";
    const bashrc = await shellConfig(place, "bash", before);
    await shellConfig(place, "fish", "# fish\n");
    await shellConfig(place, "nu", "# nu\n");
    await install(place);
    const second = await install(place);
    const third = await install(place);
    for (const run of [second, third]) {
      assertEquals(
        run.lines.filter((line) => line.startsWith("install: дополнение")),
        [
          "install: дополнение bash: без изменений",
          "install: дополнение fish: без изменений",
          "install: дополнение nu: без изменений",
        ],
      );
    }
    const text = await Deno.readTextFile(bashrc);
    assertEquals(blocks(text).length, 1);
    assertEquals(text.startsWith(before), true);
    assertEquals(
      text,
      await Deno.readTextFile(
        new URL(
          "testdata/cutover/bashrc-after-three-runs.txt",
          import.meta.url,
        ),
      ),
    );
  }));

Deno.test("дополнение: правка внутри блока затирается, соседний текст — нет", () =>
  withPlace(async (place) => {
    const bashrc = await shellConfig(place, "bash", "# сверху\n");
    await install(place);
    const edited = (await Deno.readTextFile(bashrc))
      .replace("# дополнение bash для mpu", "# правка человека") + "# снизу\n";
    await Deno.writeTextFile(bashrc, edited);
    const run = await install(place);
    assertEquals(
      run.lines.filter((line) => line.startsWith("install: дополнение bash")),
      ["install: дополнение bash: подключено"],
    );
    const text = await Deno.readTextFile(bashrc);
    // Тело вернулось дословно: обратные слэши скрипта не раскрылись.
    assertEquals(blocks(text), [fakeBody("bash")]);
    assertEquals(text.startsWith("# сверху\n"), true);
    assertEquals(text.endsWith("# снизу\n"), true);
  }));

/**
 * Дерево, в котором установщику хватает всего: он сам и эталон
 * службы. Сборка идёт поддельным `deno`, задачи ему не нужны, поэтому
 * копировать дерево целиком незачем.
 *
 * @param at каталог будущего дерева (может содержать пробел)
 */
async function fakeTree(at: string): Promise<string> {
  await Deno.mkdir(`${at}/supervisor`, { recursive: true });
  await Deno.copyFile(`${ROOT}install.sh`, `${at}/install.sh`);
  await Deno.chmod(`${at}/install.sh`, 0o755);
  await Deno.copyFile(
    `${ROOT}supervisor/mpu.service`,
    `${at}/supervisor/mpu.service`,
  );
  return `${at}/`;
}

Deno.test("зовётся по пути из чужого каталога, в том числе по ссылке", async (t) => {
  await t.step(
    "абсолютный путь, рабочий каталог — корень",
    () =>
      withPlace(async (place) => {
        const run = await install(place, [], {}, { from: "/" });
        assertEquals(run.code, 0, run.lines.join("\n"));
        assertEquals(run.lines.at(-1), "install: готово");
        assertEquals(Object.keys(await snapshot(place.bin)).sort(), PROGRAMS);
      }),
  );
  await t.step(
    "символическая ссылка на скрипт",
    () =>
      withPlace(async (place) => {
        // Ссылка разыменовывается до конца: дерево — настоящее, а не
        // каталог ссылки, где нет ни задач, ни эталона службы.
        const link = `${place.dir}/link`;
        await Deno.mkdir(link, { recursive: true });
        await Deno.symlink(`${ROOT}install.sh`, `${link}/install.sh`);
        const run = await install(place, [], {}, {
          tree: `${link}/`,
          from: "/",
        });
        assertEquals(run.code, 0, run.lines.join("\n"));
        assertEquals(run.lines.at(-1), "install: готово");
      }),
  );
  await t.step("дерево по пути с пробелом", () =>
    withPlace(async (place) => {
      const tree = await fakeTree(`${place.dir}/дерево с пробелом`);
      const run = await install(place, [], {}, { tree, from: "/" });
      assertEquals(run.code, 0, run.lines.join("\n"));
      assertEquals(run.lines.at(-1), "install: готово");
      assertEquals(
        await Deno.readTextFile(`${place.unit}/mpu.service`),
        await Deno.readTextFile(`${tree}supervisor/mpu.service`),
      );
    }));
});

Deno.test("дополнение: файл настроек — ссылка, ссылка остаётся ссылкой", () =>
  withPlace(async (place) => {
    // Точечные файлы часто лежат в чужом каталоге, а в HOME — ссылки:
    // подменять надо то, на что ссылка смотрит, иначе установка её
    // снесёт вместе с чужой историей.
    const real = `${place.dir}/dotfiles/bashrc`;
    await Deno.mkdir(`${place.dir}/dotfiles`, { recursive: true });
    await Deno.writeTextFile(real, "# сверху\n");
    await Deno.symlink(real, `${place.dir}/.bashrc`);
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(
      (await Deno.lstat(`${place.dir}/.bashrc`)).isSymlink,
      true,
      "ссылка заменена обычным файлом",
    );
    assertEquals(blocks(await Deno.readTextFile(real)), [fakeBody("bash")]);
  }));

Deno.test("дополнение: подключать нечем — пропуск, а не отказ", () =>
  withPlace(async (place) => {
    await shellConfig(place, "bash", "# сверху\n");
    // Всё, кроме `complete`: дополняющей программы на машине нет, и
    // шаг не должен ронять установку уже поставленного.
    const run = await install(place, [
      "--only",
      "back,mcp,cli,supervisor,web",
    ]);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(
      run.lines.filter((line) => line.startsWith("install: дополнение")),
      ["install: дополнение: mpu-complete не установлен"],
    );
    assertEquals(
      (await Deno.readTextFile(`${place.dir}/.bashrc`)).includes(BEGIN),
      false,
    );
  }));

Deno.test("дополнение: файл без перевода строки в конце — один блок", async (t) => {
  // Замер на живой машине 2026-09-22: `config.fish` и `config.nu` без
  // концевого перевода строки получали блок, приклеенный к хвосту чужой
  // строки; поиск маркера такого блока не видел, и следующий прогон
  // дописывал второй.
  const cases = [
    ["строка без перевода", "# чужая строка"],
    ["пустой файл", ""],
    ["одна строка с переводом", "# чужая строка\n"],
  ] as const;
  for (const [name, before] of cases) {
    await t.step(name, () =>
      withPlace(async (place) => {
        const bashrc = await shellConfig(place, "bash", before);
        await install(place);
        const second = await install(place);
        assertEquals(
          second.lines.filter((line) =>
            line.startsWith("install: дополнение bash")
          ),
          ["install: дополнение bash: без изменений"],
        );
        const text = await Deno.readTextFile(bashrc);
        assertEquals(blocks(text), [fakeBody("bash")]);
        // Чужая строка цела и маркер начинается со своей строки.
        assertEquals(text.includes(`# чужая строка${BEGIN}`), false);
        if (before !== "") {
          assertEquals(text.startsWith("# чужая строка\n"), true);
        }
      }));
  }
});

/** Заголовки MCP-клиента: токен читается при подключении, в конфиг не пишется. */
const HEADERS_HELPER =
  `printf '{"Authorization":"Bearer %s"}' "$(cat ~/.config/mpu/mcp-token)"`;

/** Запись сервера `mpu`, которую ставит установщик. */
function mpuServer(place: Place): Record<string, string> {
  return {
    type: "http",
    url: `${place.mcp.url}/mcp`,
    headersHelper: HEADERS_HELPER,
  };
}

/** Строки шага Claude Code. */
function claudeLines(run: Run): string[] {
  return run.lines.filter((line) => line.startsWith("install: claude"));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
}

Deno.test("claude: первая установка — сервер mpu пользователя и правила разрешений", () =>
  withPlace(async (place) => {
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(claudeLines(run), [
      "install: claude mcp: подключено",
      "install: claude права: вписано",
    ]);
    assertEquals(run.claude, [
      `mcp add-json --scope user mpu ${JSON.stringify(mpuServer(place))}`,
    ]);
    assertEquals(await readJson(`${place.dir}/.claude/settings.json`), {
      permissions: {
        allow: ["mcp__mpu__*", "Bash(mpu *)"],
        ask: ["Bash(mpu ask *)"],
        deny: ["Read(~/.config/mpu/**)"],
      },
    });
  }));

Deno.test("claude: второй запуск — ни вызова claude, settings.json не переписан", () =>
  withPlace(async (place) => {
    await install(place);
    const settings = `${place.dir}/.claude/settings.json`;
    const before = await Deno.stat(settings);
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(claudeLines(run), [
      "install: claude mcp: без изменений",
      "install: claude права: без изменений",
    ]);
    assertEquals(run.claude, []);
    assertEquals((await Deno.stat(settings)).ino, before.ino);
  }));

Deno.test("claude: чужие правила и ключи на месте, прежний сервер mpu заменён", () =>
  withPlace(async (place) => {
    await Deno.mkdir(`${place.dir}/.claude`);
    const settings = `${place.dir}/.claude/settings.json`;
    await Deno.writeTextFile(
      settings,
      JSON.stringify({
        model: "opus",
        permissions: {
          allow: ["Bash(git *)", "Bash(mpu *)"],
          deny: ["Read(./.env)"],
        },
      }),
    );
    await Deno.writeTextFile(
      `${place.dir}/.claude.json`,
      JSON.stringify({
        mcpServers: { mpu: { type: "http", url: "http://127.0.0.1:7337/rw" } },
      }),
    );
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(run.claude, [
      "mcp remove --scope user mpu",
      `mcp add-json --scope user mpu ${JSON.stringify(mpuServer(place))}`,
    ]);
    assertEquals(await readJson(settings), {
      model: "opus",
      permissions: {
        allow: ["Bash(git *)", "Bash(mpu *)", "mcp__mpu__*"],
        deny: ["Read(./.env)", "Read(~/.config/mpu/**)"],
        ask: ["Bash(mpu ask *)"],
      },
    });
  }));

Deno.test("claude: settings.json — ссылка, ссылка остаётся ссылкой", () =>
  withPlace(async (place) => {
    const real = `${place.dir}/dotfiles/settings.json`;
    await Deno.mkdir(`${place.dir}/dotfiles`);
    await Deno.mkdir(`${place.dir}/.claude`);
    await Deno.writeTextFile(real, "{}");
    await Deno.symlink(real, `${place.dir}/.claude/settings.json`);
    const run = await install(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(
      (await Deno.lstat(`${place.dir}/.claude/settings.json`)).isSymlink,
      true,
      "ссылка заменена обычным файлом",
    );
    assertEquals(
      ((await readJson(real)) as { permissions: { ask: string[] } })
        .permissions.ask,
      ["Bash(mpu ask *)"],
    );
  }));

Deno.test("claude: не установлен — пропуск, ~/.claude не заводится", () =>
  withPlace(async (place) => {
    const run = await install(place, [], {
      MPU_CLAUDE: `${place.dir}/нет-claude`,
    });
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(claudeLines(run), ["install: claude: не установлен"]);
    assertEquals(run.lines.at(-1), "install: готово");
    await assertRejects(
      () => Deno.stat(`${place.dir}/.claude`),
      Deno.errors.NotFound,
    );
  }));

Deno.test("claude: settings.json не JSON — отказ, файл не тронут", () =>
  withPlace(async (place) => {
    await Deno.mkdir(`${place.dir}/.claude`);
    const settings = `${place.dir}/.claude/settings.json`;
    await Deno.writeTextFile(settings, "{oops");
    const run = await install(place);
    assertEquals(run.code, 1);
    assertEquals(
      run.lines.at(-1),
      `install: claude права: ошибка: ${settings} не JSON`,
    );
    assertEquals(await Deno.readTextFile(settings), "{oops");
  }));
