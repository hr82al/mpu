/**
 * `ts/cutover.sh` (`platform/cutover.md`, «ts/cutover.sh»): одноразовая
 * уборка старого перед переключением имён. Всё во временных каталогах,
 * `systemctl` поддельный; настоящие службы и `~/.local/bin` не трогаются.
 */

import { assertEquals } from "@std/assert";
import {
  type Place,
  type Run,
  runScript,
  snapshot,
  withPlace,
} from "./testkit.ts";

/** Прогон уборки. */
function cutover(
  place: Place,
  args: readonly string[] = [],
  where: { readonly from?: string } = {},
): Promise<Run> {
  return runScript(place, "cutover.sh", args, {}, where);
}

/** Старая установка: обе службы и программа времени стройки. */
async function oldInstall(place: Place) {
  await Deno.mkdir(place.unit, { recursive: true });
  await Deno.mkdir(place.bin, { recursive: true });
  for (const unit of ["mpu-mcp.service", "mpu-next.service"]) {
    await Deno.writeTextFile(`${place.unit}/${unit}`, "[Unit]\n");
  }
  await Deno.writeTextFile(`${place.bin}/mpu-next`, "#!/bin/bash\n", {
    mode: 0o755,
  });
}

/** Строки уборки — до того, как заговорил установщик. */
function retired(run: Run): string[] {
  return run.lines.filter((line) => line.startsWith("cutover: "));
}

Deno.test("обе старые службы и mpu-next сняты, дальше идёт установка", () =>
  withPlace(async (place) => {
    await oldInstall(place);
    const run = await cutover(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(retired(run), [
      "cutover: mpu-mcp.service: снята",
      "cutover: mpu-next.service: снята",
      "cutover: mpu-next: удалён",
      "cutover: установка: запускается",
    ]);
    // Гасится явно: открытый процесс пережил бы удаление файла службы.
    assertEquals(run.calls.slice(0, 6), [
      "--user stop mpu-mcp",
      "--user disable mpu-mcp",
      "--user daemon-reload",
      "--user stop mpu-next",
      "--user disable mpu-next",
      "--user daemon-reload",
    ]);
    // Старого не осталось, новое поставлено той же командой.
    assertEquals(Object.keys(await snapshot(place.unit)), ["mpu.service"]);
    assertEquals(
      Object.keys(await snapshot(place.bin)).includes("mpu-next"),
      false,
    );
    assertEquals(run.lines.at(-1), "install: готово");
  }));

Deno.test("второй прогон: убирать нечего, установка проходит как обычно", () =>
  withPlace(async (place) => {
    await oldInstall(place);
    await cutover(place);
    const run = await cutover(place);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(retired(run), [
      "cutover: mpu-mcp.service: нечего убирать",
      "cutover: mpu-next.service: нечего убирать",
      "cutover: mpu-next: нечего убирать",
      "cutover: установка: запускается",
    ]);
    assertEquals(run.lines.at(-1), "install: готово");
  }));

Deno.test("--check: называет найденное и ничего не меняет", () =>
  withPlace(async (place) => {
    await oldInstall(place);
    const before = {
      unit: await snapshot(place.unit),
      bin: await snapshot(place.bin),
    };
    const run = await cutover(place, ["--check"]);
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(retired(run), [
      "cutover: mpu-mcp.service: есть, будет снята",
      "cutover: mpu-next.service: есть, будет снята",
      "cutover: mpu-next: есть, будет удалён",
      "cutover: готово",
    ]);
    assertEquals(run.calls, []);
    assertEquals(await snapshot(place.unit), before.unit);
    assertEquals(await snapshot(place.bin), before.bin);
  }));

Deno.test("--check из чужого каталога: дерево найдено по пути скрипта", () =>
  withPlace(async (place) => {
    await oldInstall(place);
    const run = await cutover(place, ["--check"], { from: "/" });
    assertEquals(run.code, 0, run.lines.join("\n"));
    assertEquals(
      retired(run).at(0),
      "cutover: mpu-mcp.service: есть, будет снята",
    );
    assertEquals(run.calls, []);
  }));
