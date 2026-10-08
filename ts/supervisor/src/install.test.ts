/**
 * `ts/install.sh` (`platform/supervisor-install.md`, `platform/cutover.md`):
 * сборка поддельным `bun`, служба поддельным `systemctl`, файлы настроек
 * оболочек — во временном `HOME`. Оснастка — `testkit.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

/**
 * Юниты прежнего суточного таймера образа: установка, найдя их, выключает
 * и удаляет (`platform/stage6-l1.md`, сценарий 6).
 */
const TIMER_UNITS = ["mpu-image-export.service", "mpu-image-export.timer"];

/** Юниты прежнего таймера на машине — как их ставила прежняя установка. */
async function oldTimer(place: Place, names: readonly string[] = TIMER_UNITS) {
  for (const name of names) {
    await writeFile(`${place.unit}/${name}`, `[Unit]\nDescription=${name}\n`);
  }
}

/** Есть ли файл в каталоге служб. */
async function present(place: Place, name: string): Promise<boolean> {
  try {
    await stat(`${place.unit}/${name}`);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

/** Строки шагов службы, таймера и перезапуска. */
function unitLines(run: Run): string[] {
  return run.lines.filter((line) =>
    /^install: (служба|таймер образа|перезапуск):/.test(line),
  );
}

const PROGRAMS = [
  "mpu",
  "mpu-back",
  "mpu-complete",
  "mpu-mcp",
  "mpu-supervisor",
  "mpu-task",
  "mpu-worker",
];

it("первая установка: всё собрано и поставлено, служба — эталон, start", () =>
  withPlace(async (place) => {
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(Object.keys(await snapshot(place.bin)).sort()).toStrictEqual(
      PROGRAMS,
    );
    expect(await readFile(`${place.unit}/mpu.service`, "utf8")).toStrictEqual(
      await readFile(
        new URL("testdata/supervisor-install/mpu.service", import.meta.url),
        "utf8",
      ),
    );
    for (const name of TIMER_UNITS) {
      expect(await present(place, name), name).toBe(false);
    }
    expect(run.calls).toStrictEqual([
      "--user daemon-reload",
      "--user enable mpu",
      "--user start mpu",
    ]);
    expect(unitLines(run)).toStrictEqual([
      "install: служба: записана",
      "install: перезапуск: служба запущена",
    ]);
    expect(run.lines.every((line) => line.startsWith("install: "))).toBe(true);
    expect(run.lines.at(-1)).toBe("install: готово");
  }));

it("второй запуск без изменений: ничего не ставится и не перезапускается", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(
      run.lines.filter((line) => line.includes("сравнение")),
    ).toStrictEqual(
      [
        "back",
        "worker",
        "mcp",
        "cli",
        "supervisor",
        "task",
        "complete",
        "web",
      ].map((part) => `install: сравнение ${part}: без изменений`),
    );
    expect(run.calls).toStrictEqual([]);
    expect(unitLines(run)).toStrictEqual([
      "install: служба: без изменений",
      "install: перезапуск: не нужен",
    ]);
    expect(await snapshot(place.bin)).toStrictEqual(before);
    expect(run.lines.at(-1)).toBe("install: готово");
  }));

it("стоит таймер образа: выключен и снят одной daemon-reload, повтор — без изменений", () =>
  withPlace(async (place) => {
    await install(place);
    await oldTimer(place);
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    for (const name of TIMER_UNITS) {
      expect(await present(place, name), name).toBe(false);
    }
    expect(run.calls).toStrictEqual([
      "--user disable --now mpu-image-export.timer",
      "--user daemon-reload",
    ]);
    expect(unitLines(run)).toStrictEqual([
      "install: служба: без изменений",
      "install: таймер образа: снят",
      "install: перезапуск: не нужен",
    ]);
    const again = await install(place);
    expect(again.calls).toStrictEqual([]);
    expect(unitLines(again)).toStrictEqual([
      "install: служба: без изменений",
      "install: перезапуск: не нужен",
    ]);
  }));

it("остался только юнит службы таймера: снят без disable", () =>
  withPlace(async (place) => {
    await install(place);
    await oldTimer(place, ["mpu-image-export.service"]);
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(await present(place, "mpu-image-export.service")).toBe(false);
    expect(run.calls).toStrictEqual(["--user daemon-reload"]);
    expect(unitLines(run)).toContain("install: таймер образа: снят");
  }));

it("служба изменена: служба перезапущена", () =>
  withPlace(async (place) => {
    await install(place);
    await writeFile(`${place.unit}/mpu.service`, "[Unit]\n");
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(run.calls).toStrictEqual([
      "--user daemon-reload",
      "--user enable mpu",
      "--user restart mpu",
    ]);
    expect(unitLines(run)).toStrictEqual([
      "install: служба: записана",
      "install: перезапуск: служба перезапущена",
    ]);
  }));

it("--only mcp после правки: только mpu-mcp и USR2 главному процессу", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, ["--only", "mcp"], { FAKE_TAG_mcp: "2" });
    expect(run.code, run.lines.join("\n")).toBe(0);
    const after = await snapshot(place.bin);
    for (const program of PROGRAMS) {
      expect(after[program] === before[program], program).toStrictEqual(
        program !== "mpu-mcp",
      );
    }
    expect(run.calls).toStrictEqual([
      "--user kill --kill-whom=main -s USR2 mpu",
    ]);
    const both = await install(place, ["--only", "back,mcp"], {
      FAKE_TAG_back: "3",
      FAKE_TAG_mcp: "3",
    });
    expect(both.calls).toStrictEqual([
      "--user kill --kill-whom=main -s USR1 mpu",
      "--user kill --kill-whom=main -s USR2 mpu",
    ]);
  }));

it("--only task после правки: только mpu-task, служба перезапущена целиком", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, ["--only", "task"], {
      FAKE_TAG_task: "2",
    });
    expect(run.code, run.lines.join("\n")).toBe(0);
    const after = await snapshot(place.bin);
    for (const program of PROGRAMS) {
      expect(after[program] === before[program], program).toStrictEqual(
        program !== "mpu-task",
      );
    }
    // Сигнала третьему ребёнку нет — перезапуск службы, как у
    // супервизора (решение хоста T3).
    expect(run.calls).toStrictEqual(["--user restart mpu"]);
    expect(unitLines(run).at(-1)).toBe(
      "install: перезапуск: служба перезапущена",
    );
  }));

it("--only worker после правки: только mpu-worker и USR1 — исполнителей берёт новое ядро", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, ["--only", "worker"], {
      FAKE_TAG_worker: "2",
    });
    expect(run.code, run.lines.join("\n")).toBe(0);
    const after = await snapshot(place.bin);
    for (const program of PROGRAMS) {
      expect(after[program] === before[program], program).toStrictEqual(
        program !== "mpu-worker",
      );
    }
    expect(run.calls).toStrictEqual([
      "--user kill --kill-whom=main -s USR1 mpu",
    ]);
  }));

it("сборка упала: ошибка шага, код 1, каталог программ не тронут", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, [], {
      FAKE_FAIL: "back",
      FAKE_TAG_mcp: "9",
    });
    expect(run.code).toBe(1);
    expect(run.lines.at(-1)).toBe(
      "install: сборка back: ошибка: error: сборка сломана",
    );
    expect(await snapshot(place.bin)).toStrictEqual(before);
    expect(run.calls).toStrictEqual([]);
  }));

it("--check: код 0, каталоги программ и службы без изменений", () =>
  withPlace(async (place) => {
    const empty = await install(place, ["--check"]);
    expect(empty.code, empty.lines.join("\n")).toBe(0);
    expect(await snapshot(place.bin)).toStrictEqual({});
    expect(await snapshot(place.unit)).toStrictEqual({});
    await install(place);
    const bin = await snapshot(place.bin);
    const unit = await snapshot(place.unit);
    const run = await install(place, ["--check"], { FAKE_TAG_back: "5" });
    expect(run.code).toBe(0);
    expect(run.lines.includes("install: сравнение back: изменилось")).toBe(
      true,
    );
    expect(await snapshot(place.bin)).toStrictEqual(bin);
    expect(await snapshot(place.unit)).toStrictEqual(unit);
    expect(run.calls).toStrictEqual([]);
  }));

it("старая служба рядом: отказ до установки службы, с подсказкой", () =>
  withPlace(async (place) => {
    for (const old of ["mpu-mcp.service", "mpu-next.service"]) {
      await mkdir(place.unit, { recursive: true });
      await writeFile(`${place.unit}/${old}`, "[Unit]\n");
      const run = await install(place);
      expect(run.code).toBe(1);
      expect(run.lines.at(-1)).toStrictEqual(
        `install: служба: ошибка: рядом старая служба ${old}, ` +
          `снимите её: systemctl --user disable --now ${old.slice(
            0,
            -".service".length,
          )}`,
      );
      // Ни служба не поставлена, ни программы: отказ приходит до
      // сборки, и машина не остаётся наполовину переключённой.
      expect(Object.keys(await snapshot(place.unit))).toStrictEqual([old]);
      expect(await snapshot(place.bin)).toStrictEqual({});
      expect(run.calls).toStrictEqual([]);
      await rm(`${place.unit}/${old}`);
    }
  }));

it("--only с неизвестной частью — ошибка аргументов, ничего не собрано", () =>
  withPlace(async (place) => {
    const run = await install(place, ["--only", "back,nope"]);
    expect(run.code).toBe(1);
    expect(run.lines).toStrictEqual([
      "install: аргументы: ошибка: нет части nope",
    ]);
    expect(await snapshot(place.bin)).toStrictEqual({});
    expect(run.calls).toStrictEqual([]);
  }));

it("после перезапуска проверка ждёт ответа нового процесса (другой pid)", () =>
  withPlace(async (place) => {
    await install(place);
    const run = await install(place, ["--only", "back,mcp"], {
      FAKE_TAG_back: "7",
      FAKE_TAG_mcp: "7",
    });
    expect(run.code, run.lines.join("\n")).toBe(0);
    // Старый процесс ещё отвечал: установка не засчитала его ответ.
    expect(place.back.seen.newPid).toBe(true);
    expect(place.mcp.seen.newPid).toBe(true);
  }));

it("--only complete: поставлен только mpu-complete, без службы и сигналов", () =>
  withPlace(async (place) => {
    await install(place);
    const before = await snapshot(place.bin);
    const run = await install(place, ["--only", "complete"], {
      FAKE_TAG_complete: "2",
    });
    expect(run.code, run.lines.join("\n")).toBe(0);
    const after = await snapshot(place.bin);
    for (const program of PROGRAMS) {
      expect(after[program] === before[program], program).toStrictEqual(
        program !== "mpu-complete",
      );
    }
    expect(run.calls).toStrictEqual([]);
    expect(run.lines.at(-1)).toBe("install: готово");
  }));

it("фронт: каталог web/<хэш>/ и ссылка current, без службы; прежняя сборка остаётся", () =>
  withPlace(async (place) => {
    await install(place);
    const web = `${place.dir}/web`;
    const first = await readlink(`${web}/current`);
    expect(/^[0-9a-f]{64}$/.test(first), first).toBe(true);
    expect(await readFile(`${web}/current/index.html`, "utf8")).toBe(
      "<html>1</html>\n",
    );
    const same = await install(place, ["--only", "web"]);
    expect(same.lines.includes("install: сравнение web: без изменений")).toBe(
      true,
    );
    const run = await install(place, ["--only", "web"], { FAKE_TAG_web: "2" });
    expect(run.code, run.lines.join("\n")).toBe(0);
    const second = await readlink(`${web}/current`);
    expect(second === first).toBe(false);
    expect(await readFile(`${web}/current/index.html`, "utf8")).toBe(
      "<html>2</html>\n",
    );
    expect((await stat(`${web}/${first}`)).isDirectory()).toBe(true);
    // Только фронт изменился — служба не трогается.
    expect(run.calls).toStrictEqual([]);
  }));

/** Файл настроек оболочки во временном HOME. */
async function shellConfig(place: Place, shell: string, text: string) {
  const paths: Record<string, string> = {
    bash: `${place.dir}/.bashrc`,
    fish: `${place.dir}/config/fish/config.fish`,
    nu: `${place.dir}/config/nushell/config.nu`,
  };
  const path = paths[shell];
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, text);
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

it("дополнение: блок в каждой настроенной оболочке, прочие — не настроены", () =>
  withPlace(async (place) => {
    const bashrc = await shellConfig(place, "bash", "export PS1='$ '\n");
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(
      run.lines.filter((line) => line.startsWith("install: дополнение")),
    ).toStrictEqual([
      "install: дополнение bash: подключено",
      "install: дополнение fish: не настроена",
      "install: дополнение nu: не настроена",
    ]);
    const text = await readFile(bashrc, "utf8");
    expect(blocks(text)).toStrictEqual([fakeBody("bash")]);
    // Текст человека остался на месте.
    expect(text.startsWith("export PS1='$ '\n")).toBe(true);
  }));

it("дополнение: три прогона — один блок, чужой текст не тронут", () =>
  withPlace(async (place) => {
    const before = "export PS1='$ '\n# хвост человека\n";
    const bashrc = await shellConfig(place, "bash", before);
    await shellConfig(place, "fish", "# fish\n");
    const nuConfig = await shellConfig(place, "nu", "# nu\n");
    // Без claude: эталон файла — только блок дополнения
    // (`platform/cutover.md`), блок канала у него свой тест.
    const noClaude = { MPU_CLAUDE: `${place.dir}/нет-claude` };
    const first = await install(place, [], noClaude);
    expect(
      first.lines.filter((line) => line.startsWith("install: дополнение nu")),
    ).toStrictEqual(["install: дополнение nu: подключено"]);
    const second = await install(place, [], noClaude);
    const third = await install(place, [], noClaude);
    for (const run of [second, third]) {
      expect(
        run.lines.filter((line) => line.startsWith("install: дополнение")),
      ).toStrictEqual([
        "install: дополнение bash: без изменений",
        "install: дополнение fish: без изменений",
        "install: дополнение nu: без изменений",
      ]);
    }
    expect(blocks(await readFile(nuConfig, "utf8"))).toStrictEqual([
      fakeBody("nu"),
    ]);
    const text = await readFile(bashrc, "utf8");
    expect(blocks(text).length).toBe(1);
    expect(text.startsWith(before)).toBe(true);
    expect(text).toStrictEqual(
      await readFile(
        new URL(
          "testdata/cutover/bashrc-after-three-runs.txt",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }));

it("дополнение: nu запускающего тестам не виден", () =>
  withPlace(async (place) => {
    await shellConfig(place, "nu", "# nu\n");
    // Приманка в начале PATH отвечает чужим каталогом: установщик,
    // спросивший её, а не подмену, не нашёл бы config.nu.
    await mkdir(`${place.dir}/path`);
    await writeFile(
      `${place.dir}/path/nu`,
      `#!/bin/bash\necho ${place.dir}/чужой\n`,
      { mode: 0o755 },
    );
    const run = await install(place, [], {
      PATH: `${place.dir}/path:${process.env["PATH"]}`,
    });
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(
      run.lines.filter((line) => line.startsWith("install: дополнение nu")),
    ).toStrictEqual(["install: дополнение nu: подключено"]);
  }));

it("дополнение: nu не установлен — не настроена, установка идёт дальше", () =>
  withPlace(async (place) => {
    // config.nu на месте: «не настроена» здесь говорит об отсутствии nu,
    // а не файла.
    const nuConfig = await shellConfig(place, "nu", "# nu\n");
    const run = await install(place, [], { MPU_NU: `${place.dir}/нет-nu` });
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(
      run.lines.filter((line) => line.startsWith("install: дополнение nu")),
    ).toStrictEqual(["install: дополнение nu: не настроена"]);
    expect(await readFile(nuConfig, "utf8")).toBe("# nu\n");
  }));

it("дополнение: правка внутри блока затирается, соседний текст — нет", () =>
  withPlace(async (place) => {
    const bashrc = await shellConfig(place, "bash", "# сверху\n");
    await install(place);
    const edited =
      (await readFile(bashrc, "utf8")).replace(
        "# дополнение bash для mpu",
        "# правка человека",
      ) + "# снизу\n";
    await writeFile(bashrc, edited);
    const run = await install(place);
    expect(
      run.lines.filter((line) => line.startsWith("install: дополнение bash")),
    ).toStrictEqual(["install: дополнение bash: подключено"]);
    const text = await readFile(bashrc, "utf8");
    // Тело вернулось дословно: обратные слэши скрипта не раскрылись.
    expect(blocks(text)).toStrictEqual([fakeBody("bash")]);
    expect(text.startsWith("# сверху\n")).toBe(true);
    expect(text.endsWith("# снизу\n")).toBe(true);
  }));

/**
 * Дерево, в котором установщику хватает всего: он сам и эталон
 * службы. Сборка идёт поддельным `bun`, задачи ему не нужны, поэтому
 * копировать дерево целиком незачем.
 *
 * @param at каталог будущего дерева (может содержать пробел)
 */
async function fakeTree(at: string): Promise<string> {
  await mkdir(`${at}/supervisor`, { recursive: true });
  await copyFile(`${ROOT}install.sh`, `${at}/install.sh`);
  await chmod(`${at}/install.sh`, 0o755);
  await copyFile(
    `${ROOT}supervisor/mpu.service`,
    `${at}/supervisor/mpu.service`,
  );
  return `${at}/`;
}

describe("зовётся по пути из чужого каталога, в том числе по ссылке", () => {
  it("абсолютный путь, рабочий каталог — корень", () =>
    withPlace(async (place) => {
      const run = await install(place, [], {}, { from: "/" });
      expect(run.code, run.lines.join("\n")).toBe(0);
      expect(run.lines.at(-1)).toBe("install: готово");
      expect(Object.keys(await snapshot(place.bin)).sort()).toStrictEqual(
        PROGRAMS,
      );
    }));
  it("символическая ссылка на скрипт", () =>
    withPlace(async (place) => {
      // Ссылка разыменовывается до конца: дерево — настоящее, а не
      // каталог ссылки, где нет ни задач, ни эталона службы.
      const link = `${place.dir}/link`;
      await mkdir(link, { recursive: true });
      await symlink(`${ROOT}install.sh`, `${link}/install.sh`);
      const run = await install(
        place,
        [],
        {},
        {
          tree: `${link}/`,
          from: "/",
        },
      );
      expect(run.code, run.lines.join("\n")).toBe(0);
      expect(run.lines.at(-1)).toBe("install: готово");
    }));
  it("дерево по пути с пробелом", () =>
    withPlace(async (place) => {
      const tree = await fakeTree(`${place.dir}/дерево с пробелом`);
      const run = await install(place, [], {}, { tree, from: "/" });
      expect(run.code, run.lines.join("\n")).toBe(0);
      expect(run.lines.at(-1)).toBe("install: готово");
      expect(await readFile(`${place.unit}/mpu.service`, "utf8")).toStrictEqual(
        await readFile(`${tree}supervisor/mpu.service`, "utf8"),
      );
    }));
});

it("дополнение: файл настроек — ссылка, ссылка остаётся ссылкой", () =>
  withPlace(async (place) => {
    // Точечные файлы часто лежат в чужом каталоге, а в HOME — ссылки:
    // подменять надо то, на что ссылка смотрит, иначе установка её
    // снесёт вместе с чужой историей.
    const real = `${place.dir}/dotfiles/bashrc`;
    await mkdir(`${place.dir}/dotfiles`, { recursive: true });
    await writeFile(real, "# сверху\n");
    await symlink(real, `${place.dir}/.bashrc`);
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(
      (await lstat(`${place.dir}/.bashrc`)).isSymbolicLink(),
      "ссылка заменена обычным файлом",
    ).toBe(true);
    expect(blocks(await readFile(real, "utf8"))).toStrictEqual([
      fakeBody("bash"),
    ]);
  }));

it("дополнение: подключать нечем — пропуск, а не отказ", () =>
  withPlace(async (place) => {
    await shellConfig(place, "bash", "# сверху\n");
    // Всё, кроме `complete`: дополняющей программы на машине нет, и
    // шаг не должен ронять установку уже поставленного.
    const run = await install(place, ["--only", "back,mcp,cli,supervisor,web"]);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(
      run.lines.filter((line) => line.startsWith("install: дополнение")),
    ).toStrictEqual(["install: дополнение: mpu-complete не установлен"]);
    expect(
      (await readFile(`${place.dir}/.bashrc`, "utf8")).includes(BEGIN),
    ).toBe(false);
  }));

describe("дополнение: файл без перевода строки в конце — один блок", () => {
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
    it(name, () =>
      withPlace(async (place) => {
        const bashrc = await shellConfig(place, "bash", before);
        await install(place);
        const second = await install(place);
        expect(
          second.lines.filter((line) =>
            line.startsWith("install: дополнение bash"),
          ),
        ).toStrictEqual(["install: дополнение bash: без изменений"]);
        const text = await readFile(bashrc, "utf8");
        expect(blocks(text)).toStrictEqual([fakeBody("bash")]);
        // Чужая строка цела и маркер начинается со своей строки.
        expect(text.includes(`# чужая строка${BEGIN}`)).toBe(false);
        if (before !== "") {
          expect(text.startsWith("# чужая строка\n")).toBe(true);
        }
      }),
    );
  }
});

/** Заголовки MCP-клиента: токен читается при подключении, в конфиг не пишется. */
const HEADERS_HELPER = `printf '{"Authorization":"Bearer %s"}' "$(cat ~/.config/mpu/mcp-token)"`;

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

/** Строка шага `step` («claude хук stop», «claude канал bash»). */
function stepLine(run: Run, step: string): string | undefined {
  return run.lines.find((line) => line.startsWith(`install: ${step}:`));
}

/** Строки канала Claude Code на машине без настроенных оболочек. */
function channelLines(server: string): string[] {
  return [
    `install: claude канал сервер: ${server}`,
    "install: claude канал bash: не настроена",
    "install: claude канал fish: не настроена",
    "install: claude канал nu: не настроена",
  ];
}

/** Сервер канала пользовательского уровня (`claude-channel.md`, «Установка»). */
function channelServer(place: Place): Record<string, unknown> {
  return {
    type: "stdio",
    command: `${place.dir}/bin/mpu`,
    args: ["claude-channel"],
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Запись хука `PermissionRequest` из эталона фрагмента
 * (`claude-hook-permission-request.md`, «Фрагмент настроек и установка»).
 */
async function hookEntry(): Promise<unknown> {
  const fragment = (await readJson(
    new URL(
      "testdata/claude-hook-permission-request/settings-fragment.json",
      import.meta.url,
    ).pathname,
  )) as { hooks: { PermissionRequest: unknown[] } };
  return fragment.hooks.PermissionRequest[0];
}

/** Запись хука `Notification` из эталона фрагмента (порция R4). */
async function notificationEntry(): Promise<unknown> {
  const fragment = (await readJson(
    new URL(
      "testdata/claude-hook-notification/settings-fragment-notification.json",
      import.meta.url,
    ).pathname,
  )) as { hooks: { Notification: unknown[] } };
  return fragment.hooks.Notification[0];
}

/**
 * Запись хука `Elicitation` из эталона фрагмента
 * (`claude-hook-elicitation.md`, «Установка»).
 */
async function elicitationEntry(): Promise<unknown> {
  const fragment = (await readJson(
    new URL(
      "testdata/claude-hook-elicitation/settings-fragment-elicitation.json",
      import.meta.url,
    ).pathname,
  )) as { hooks: { Elicitation: unknown[] } };
  return fragment.hooks.Elicitation[0];
}

/** Запись хука `Stop` из эталона фрагмента (`claude-hook-stop.md`, «Установка»). */
async function stopEntry(): Promise<unknown> {
  const fragment = (await readJson(
    new URL(
      "testdata/claude-hook-stop/settings-fragment-stop.json",
      import.meta.url,
    ).pathname,
  )) as { hooks: { Stop: unknown[] } };
  return fragment.hooks.Stop[0];
}

it("claude: первая установка — сервер mpu пользователя и правила разрешений", () =>
  withPlace(async (place) => {
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(claudeLines(run)).toStrictEqual([
      "install: claude mcp: подключено",
      "install: claude права: вписано",
      "install: claude хук permission-request: вписано",
      "install: claude хук stop: вписано",
      "install: claude хук notification: вписано",
      "install: claude хук elicitation: вписано",
      ...channelLines("подключено"),
    ]);
    expect(run.claude).toStrictEqual([
      `mcp add-json --scope user mpu ${JSON.stringify(mpuServer(place))}`,
      `mcp add-json --scope user mpu-channel ${JSON.stringify(
        channelServer(place),
      )}`,
    ]);
    expect(await readJson(`${place.dir}/.claude/settings.json`)).toStrictEqual({
      permissions: {
        allow: ["mcp__mpu__*", "Bash(mpu *)"],
        ask: ["Bash(mpu ask *)"],
        deny: ["Read(~/.config/mpu/**)"],
      },
      hooks: {
        PermissionRequest: [await hookEntry()],
        Stop: [await stopEntry()],
        Notification: [await notificationEntry()],
        Elicitation: [await elicitationEntry()],
      },
    });
  }));

it("claude: второй запуск — ни вызова claude, settings.json не переписан", () =>
  withPlace(async (place) => {
    await install(place);
    const settings = `${place.dir}/.claude/settings.json`;
    const before = await stat(settings);
    const bytes = await readFile(settings);
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(claudeLines(run)).toStrictEqual([
      "install: claude mcp: без изменений",
      "install: claude права: без изменений",
      "install: claude хук permission-request: без изменений",
      "install: claude хук stop: без изменений",
      "install: claude хук notification: без изменений",
      "install: claude хук elicitation: без изменений",
      ...channelLines("без изменений"),
    ]);
    expect(run.claude).toStrictEqual([]);
    const after = await stat(settings);
    expect([after.ino, after.mtime]).toStrictEqual([before.ino, before.mtime]);
    expect(await readFile(settings)).toStrictEqual(bytes);
  }));

it("claude: чужие правила и ключи на месте, прежний сервер mpu заменён", () =>
  withPlace(async (place) => {
    await mkdir(`${place.dir}/.claude`);
    const settings = `${place.dir}/.claude/settings.json`;
    await writeFile(
      settings,
      JSON.stringify({
        model: "opus",
        permissions: {
          allow: ["Bash(git *)", "Bash(mpu *)"],
          deny: ["Read(./.env)"],
        },
      }),
    );
    await writeFile(
      `${place.dir}/.claude.json`,
      JSON.stringify({
        mcpServers: { mpu: { type: "http", url: "http://127.0.0.1:7337/rw" } },
      }),
    );
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(run.claude).toStrictEqual([
      "mcp remove --scope user mpu",
      `mcp add-json --scope user mpu ${JSON.stringify(mpuServer(place))}`,
      `mcp add-json --scope user mpu-channel ${JSON.stringify(
        channelServer(place),
      )}`,
    ]);
    expect(await readJson(settings)).toStrictEqual({
      model: "opus",
      permissions: {
        allow: ["Bash(git *)", "Bash(mpu *)", "mcp__mpu__*"],
        deny: ["Read(./.env)", "Read(~/.config/mpu/**)"],
        ask: ["Bash(mpu ask *)"],
      },
      hooks: {
        PermissionRequest: [await hookEntry()],
        Stop: [await stopEntry()],
        Notification: [await notificationEntry()],
        Elicitation: [await elicitationEntry()],
      },
    });
  }));

/** Запись хука с командой `command` и сроком `timeout`. */
function entry(command: string, timeout?: number, matcher = "") {
  return {
    matcher,
    hooks: [
      {
        type: "command",
        command,
        ...(timeout === undefined ? {} : { timeout }),
      },
    ],
  };
}

const HOOK = "mpu claude-hook permission-request";

it("claude хук: правленая запись заменена своей на месте первой, чужие целы", () =>
  withPlace(async (place) => {
    await mkdir(`${place.dir}/.claude`);
    const settings = `${place.dir}/.claude/settings.json`;
    const other = entry("notify-me", 5, "Bash");
    await writeFile(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [entry("mpu claude-hook pre-tool-use", 10)],
          PermissionRequest: [
            other,
            entry(HOOK, 600),
            entry("later"),
            entry(HOOK, 3600, "Bash"),
          ],
        },
      }),
    );
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(stepLine(run, "claude хук permission-request")).toBe(
      "install: claude хук permission-request: вписано",
    );
    expect(
      ((await readJson(settings)) as { hooks: unknown }).hooks,
    ).toStrictEqual({
      PreToolUse: [entry("mpu claude-hook pre-tool-use", 10)],
      PermissionRequest: [other, await hookEntry(), entry("later")],
      Stop: [await stopEntry()],
      Notification: [await notificationEntry()],
      Elicitation: [await elicitationEntry()],
    });
  }));

it("R2a-11: хук stop — вписан рядом с чужими записями Stop, повторно — те же байты", () =>
  withPlace(async (place) => {
    await mkdir(`${place.dir}/.claude`);
    const settings = `${place.dir}/.claude/settings.json`;
    const other = entry("notify-done", 5);
    await writeFile(
      settings,
      JSON.stringify({
        hooks: { Stop: [other, entry("mpu claude-hook stop", 600)] },
      }),
    );
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(stepLine(run, "claude хук stop")).toBe(
      "install: claude хук stop: вписано",
    );
    expect(
      ((await readJson(settings)) as { hooks: { Stop: unknown } }).hooks.Stop,
    ).toStrictEqual([other, await stopEntry()]);
    const bytes = await readFile(settings);
    const again = await install(place);
    expect(stepLine(again, "claude хук stop")).toBe(
      "install: claude хук stop: без изменений",
    );
    expect(await readFile(settings)).toStrictEqual(bytes);
  }));

it("claude: settings.json — ссылка, ссылка остаётся ссылкой", () =>
  withPlace(async (place) => {
    const real = `${place.dir}/dotfiles/settings.json`;
    await mkdir(`${place.dir}/dotfiles`);
    await mkdir(`${place.dir}/.claude`);
    await writeFile(real, "{}");
    await symlink(real, `${place.dir}/.claude/settings.json`);
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(
      (await lstat(`${place.dir}/.claude/settings.json`)).isSymbolicLink(),
      "ссылка заменена обычным файлом",
    ).toBe(true);
    expect(
      ((await readJson(real)) as { permissions: { ask: string[] } }).permissions
        .ask,
    ).toStrictEqual(["Bash(mpu ask *)"]);
  }));

it("claude: не установлен — пропуск, ~/.claude не заводится", () =>
  withPlace(async (place) => {
    const run = await install(place, [], {
      MPU_CLAUDE: `${place.dir}/нет-claude`,
    });
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(claudeLines(run)).toStrictEqual(["install: claude: не установлен"]);
    expect(run.lines.at(-1)).toBe("install: готово");
    await expect(stat(`${place.dir}/.claude`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }));

it("claude: settings.json не JSON — отказ, файл не тронут", () =>
  withPlace(async (place) => {
    await mkdir(`${place.dir}/.claude`);
    const settings = `${place.dir}/.claude/settings.json`;
    await writeFile(settings, "{oops");
    const run = await install(place);
    expect(run.code).toBe(1);
    expect(run.lines.at(-1)).toStrictEqual(
      `install: claude права: ошибка: ${settings} не JSON`,
    );
    expect(await readFile(settings, "utf8")).toBe("{oops");
  }));

it("копия фрагмента настроек совпадает с каналом спецификаций", async () => {
  expect(
    await readFile(
      new URL(
        "testdata/claude-hook-permission-request/settings-fragment.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).toStrictEqual(
    await readFile(
      new URL(
        "../../docs/specs/fixtures/telegram-relay/settings-fragment.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

it("копия фрагмента хука stop совпадает с каналом спецификаций", async () => {
  expect(
    await readFile(
      new URL(
        "testdata/claude-hook-stop/settings-fragment-stop.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).toStrictEqual(
    await readFile(
      new URL(
        "../../docs/specs/fixtures/telegram-relay/r2/settings-fragment-stop.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

const CLAUDE_BEGIN = "# >>> mpu claude >>>";
const CLAUDE_END = "# <<< mpu claude <<<";

/** Тело блока `claude` в файле; блока нет — `undefined`. */
function claudeBlock(text: string): string | undefined {
  const begin = text.indexOf(`${CLAUDE_BEGIN}\n`);
  const end = text.indexOf(`\n${CLAUDE_END}`);
  if (begin < 0 || end < 0) return undefined;
  return text.slice(begin + CLAUDE_BEGIN.length + 1, end);
}

it("R2b-10: канал — сервер и алиас claude в каждой оболочке; повторно — без изменений, те же байты", () =>
  withPlace(async (place) => {
    const bashrc = await shellConfig(place, "bash", "export PS1='$ '\n");
    const fish = await shellConfig(place, "fish", "# fish\n");
    const nu = await shellConfig(place, "nu", "# nu\n");
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(
      run.lines.filter((line) => line.startsWith("install: claude канал")),
    ).toStrictEqual([
      "install: claude канал сервер: подключено",
      "install: claude канал bash: подключено",
      "install: claude канал fish: подключено",
      "install: claude канал nu: подключено",
    ]);
    const flag = "--dangerously-load-development-channels server:mpu-channel";
    expect(claudeBlock(await readFile(bashrc, "utf8"))).toStrictEqual(
      `unalias claude 2>/dev/null; function claude { command claude ${flag} "$@"; }`,
    );
    expect(claudeBlock(await readFile(fish, "utf8"))).toStrictEqual(
      `function claude --wraps claude; command claude ${flag} $argv; end`,
    );
    expect(claudeBlock(await readFile(nu, "utf8"))).toStrictEqual(
      `def --wrapped claude [...rest] { ^claude ${flag} ...$rest }`,
    );
    // Блок дополнения — свой, отдельный.
    expect(blocks(await readFile(bashrc, "utf8"))).toStrictEqual([
      fakeBody("bash"),
    ]);
    const bytes = await Promise.all(
      [bashrc, fish, nu].map((path) => readFile(path)),
    );
    const again = await install(place);
    expect(
      again.lines.filter((line) => line.startsWith("install: claude канал")),
    ).toStrictEqual([
      "install: claude канал сервер: без изменений",
      "install: claude канал bash: без изменений",
      "install: claude канал fish: без изменений",
      "install: claude канал nu: без изменений",
    ]);
    expect(again.claude).toStrictEqual([]);
    expect(
      await Promise.all([bashrc, fish, nu].map((path) => readFile(path))),
    ).toStrictEqual(bytes);
  }));

it("R2b-10: правка внутри блока claude затирается целиком; иной сервер канала заменён", () =>
  withPlace(async (place) => {
    const bashrc = await shellConfig(place, "bash", "# сверху\n");
    await install(place);
    const edited =
      (await readFile(bashrc, "utf8")).replace(
        "command claude",
        "command my-claude",
      ) + "# снизу\n";
    await writeFile(bashrc, edited);
    const claudeJson = `${place.dir}/.claude.json`;
    const config = JSON.parse(await readFile(claudeJson, "utf8"));
    config.mcpServers["mpu-channel"] = { type: "stdio", command: "старый" };
    await writeFile(claudeJson, JSON.stringify(config));
    const run = await install(place);
    expect(stepLine(run, "claude канал bash")).toBe(
      "install: claude канал bash: подключено",
    );
    expect(stepLine(run, "claude канал сервер")).toBe(
      "install: claude канал сервер: подключено",
    );
    expect(run.claude).toStrictEqual([
      "mcp remove --scope user mpu-channel",
      `mcp add-json --scope user mpu-channel ${JSON.stringify(
        channelServer(place),
      )}`,
    ]);
    const text = await readFile(bashrc, "utf8");
    expect(text.includes("my-claude")).toBe(false);
    expect(text.startsWith("# сверху\n")).toBe(true);
    expect(text.endsWith("# снизу\n")).toBe(true);
  }));

it("R3-15: хук elicitation — вписан рядом с чужими записями, повторно — без изменений; копия фрагмента — как в канале", async () => {
  await withPlace(async (place) => {
    await mkdir(`${place.dir}/.claude`);
    const settings = `${place.dir}/.claude/settings.json`;
    const other = entry("notify-form", 5);
    await writeFile(
      settings,
      JSON.stringify({
        hooks: {
          Elicitation: [other, entry("mpu claude-hook elicitation", 600)],
        },
      }),
    );
    const run = await install(place);
    expect(run.code, run.lines.join("\n")).toBe(0);
    expect(stepLine(run, "claude хук elicitation")).toBe(
      "install: claude хук elicitation: вписано",
    );
    expect(
      ((await readJson(settings)) as { hooks: { Elicitation: unknown } }).hooks
        .Elicitation,
    ).toStrictEqual([other, await elicitationEntry()]);
    const bytes = await readFile(settings);
    const again = await install(place);
    expect(stepLine(again, "claude хук elicitation")).toBe(
      "install: claude хук elicitation: без изменений",
    );
    expect(await readFile(settings)).toStrictEqual(bytes);
  });
  expect(
    await readFile(
      new URL(
        "testdata/claude-hook-elicitation/settings-fragment-elicitation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).toStrictEqual(
    await readFile(
      new URL(
        "../../docs/specs/fixtures/telegram-relay/r3/settings-fragment-elicitation.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

it("R4-14: хук notification — вписан, повторно — без изменений; копия фрагмента — как в канале", async () => {
  await withPlace(async (place) => {
    const run = await install(place);
    expect(stepLine(run, "claude хук notification")).toBe(
      "install: claude хук notification: вписано",
    );
    const again = await install(place);
    expect(stepLine(again, "claude хук notification")).toBe(
      "install: claude хук notification: без изменений",
    );
  });
  expect(
    await readFile(
      new URL(
        "testdata/claude-hook-notification/settings-fragment-notification.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).toStrictEqual(
    await readFile(
      new URL(
        "../../docs/specs/fixtures/telegram-relay/r4/settings-fragment-notification.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
