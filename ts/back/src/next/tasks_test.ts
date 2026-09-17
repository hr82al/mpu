/**
 * Права задачи `next` — те же, что у задачи `build`
 * (`platform/registry-objects.md`, «`mpu-next`»): это та же программа,
 * запущенная из исходников. Разъехавшись, списки дали бы точке входа
 * доступ, которого у собранного бинаря нет, и заметить это было бы
 * некому: `deno task smoke` гоняет только сборку.
 */

import { assertEquals, assertGreater } from "@std/assert";

function permissionsOf(denoJsonc: string, task: string): string[] {
  const line = denoJsonc.match(new RegExp(`"${task}": "([^"]*)"`))?.[1] ?? "";
  return line
    .split(/\s+/)
    .filter((arg) => arg.startsWith("--allow") || arg.startsWith("--deny"))
    .sort();
}

Deno.test("права next и build совпадают", async () => {
  const denoJsonc = await Deno.readTextFile("deno.jsonc");
  const build = permissionsOf(denoJsonc, "build");
  // Пустые списки совпали бы между собой молча.
  assertGreater(build.length, 3, "прав задачи build не нашлось");
  assertEquals(permissionsOf(denoJsonc, "next"), build);
});
