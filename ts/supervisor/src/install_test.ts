/**
 * `ts/install.sh` (`platform/supervisor-install.md`, `platform/cutover.md`):
 * сборка поддельным `deno`, служба поддельным `systemctl`, файлы настроек
 * оболочек — во временном `HOME`. Оснастка — `testkit.ts`.
 */

import { assertEquals } from "@std/assert";
import {
  type Place,
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
): Promise<Run> {
  return runScript(place, "install.sh", args, env);
}

const PROGRAMS = [
  "mpu",
  "mpu-back",
  "mpu-complete",
  "mpu-mcp",
  "mpu-supervisor",
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
          "сначала ./cutover.sh",
      );
      // Служба не поставлена: в каталоге только чужой файл.
      assertEquals(Object.keys(await snapshot(place.unit)), [old]);
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
