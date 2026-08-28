/**
 * Временный файл дампа (`docs/specs/copy-client.md`, «Известные
 * ловушки»): каталог, в который он ложится, обязан совпадать с тем, на
 * который у собранного бинаря есть право записи (`deno.jsonc`,
 * `--allow-write`). Разойдутся — упадёт бинарь у пользователя, а не
 * тест здесь.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  DUMP_DIRS,
  makeDumpFile,
  removeDumpFile,
  spawnRedis,
} from "./tools.ts";

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

Deno.test("настоящий запуск redis: подача, код возврата, причина отказа", async (t) => {
  // Исходный дефект был в том, что настоящий исполнитель никем не
  // исполнялся и никем не проверялся. Проверяется он теми же
  // разрешёнными бинарями, что и подпроцесс ssh (`deno.jsonc`, задача
  // `test`), — живого docker в прогоне нет и не должно быть.
  await t.step("успех: stdin принят, отказа нет", async () => {
    await spawnRedis(["/bin/echo", "проба"], "значение");
  });

  await t.step(
    "ненулевой код без stderr — причиной становится код",
    async () => {
      const err = await assertRejects(
        () => spawnRedis(["/bin/false"], ""),
        Error,
      );
      assertEquals(err.message, "код 1");
    },
  );

  await t.step("процесс, не читающий ввод, не подменяет причину", async () => {
    // Ввод заведомо больше трубы (её буфер — десятки килобайт), а
    // `/bin/false` не читает ничего и выходит сразу. Пиши мы всё до
    // первого чтения — запись отвергло бы BrokenPipe, и наверх ушла бы
    // жалоба на трубу вместо настоящей причины отказа. Подача и чтение
    // идут одновременно, поэтому причиной остаётся код возврата.
    const err = await assertRejects(
      () => spawnRedis(["/bin/false"], "п".repeat(200_000)),
      Error,
    );
    assertEquals(err.message, "код 1");
  });

  await t.step("нечего запускать — отказ, а не тишина", async () => {
    // Отсутствие бинаря обязано дойти до вызывающего: шаг best-effort
    // превратит его в предупреждение, но решает это он, а не мы.
    await assertRejects(() => spawnRedis(["/bin/net-takogo-binarya"], ""));
  });
});
