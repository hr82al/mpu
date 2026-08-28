/**
 * Временный файл дампа (`docs/specs/copy-client.md`, «Известные
 * ловушки»): каталог, в который он ложится, обязан совпадать с тем, на
 * который у собранного бинаря есть право записи (`deno.jsonc`,
 * `--allow-write`). Разойдутся — упадёт бинарь у пользователя, а не
 * тест здесь.
 */

import { assertEquals } from "@std/assert";
import { DUMP_DIRS, makeDumpFile, removeDumpFile } from "./tools.ts";

Deno.test("временный файл дампа ложится в каталог временных файлов", () => {
  // Эталон — тот же системный каталог, что берёт `Deno.makeTempFileSync`
  // без аргументов.
  const reference = Deno.makeTempFileSync({ prefix: "mpu-reference-" });
  const dump = makeDumpFile("mpu-test-");
  try {
    const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
    assertEquals(dirOf(dump), dirOf(reference));
    assertEquals(dump.includes("mpu-test-"), true, dump);
    assertEquals(dump.endsWith(".dump"), true, dump);
  } finally {
    removeDumpFile(dump);
    removeDumpFile(reference);
  }
});

Deno.test("названные каталоги совпадают с правом задачи build", async () => {
  // Текст отказа перечисляет каталоги, а право их разрешает — два
  // места про одно. Сверка здесь: разойдясь, они дали бы оператору
  // совет, которого сборка не поддерживает.
  const denoJsonc = await Deno.readTextFile(
    new URL("../../deno.jsonc", import.meta.url),
  );
  const build = denoJsonc.match(/"build":\s*"([^"]*)"/)?.[1] ?? "";
  const write = build.split(/\s+/)
    .find((arg) => arg.startsWith("--allow-write="))
    ?.slice("--allow-write=".length)
    .split(",") ?? [];
  for (const dir of DUMP_DIRS) {
    assertEquals(write.includes(dir), true, `${dir} нет в --allow-write`);
  }
});

Deno.test("удаление временного файла: отсутствие файла — не отказ", () => {
  const path = makeDumpFile("mpu-test-");
  removeDumpFile(path);
  // Второе удаление того же пути молчит: упавший дамп мог не создать
  // файла вовсе, и уборка не должна ронять вызов поверх его отказа.
  removeDumpFile(path);
});
