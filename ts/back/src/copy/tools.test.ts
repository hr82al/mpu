/**
 * Временный файл дампа (`docs/specs/copy-client.md`, «Известные
 * ловушки»): каталог, в который он ложится, обязан совпадать с тем, на
 * который у собранного бинаря есть право записи (`deno.jsonc`,
 * `--allow-write`). Разойдутся — упадёт бинарь у пользователя, а не
 * тест здесь.
 */

import { assert, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BACK_TASK } from "../../scripts/compile_task.ts";
import {
  DUMP_DIRS,
  makeDumpFile,
  removeDumpFile,
  spawnRedis,
} from "./tools.ts";

it("временный файл дампа ложится в каталог временных файлов", () => {
  // Эталон — системный каталог временных файлов: тот же `TMPDIR`, что
  // берёт временный файл без аргументов.
  const reference = mkdtempSync(join(tmpdir(), "mpu-reference-"));
  const dump = makeDumpFile("mpu-test-");
  try {
    const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
    expect(dirOf(dump)).toStrictEqual(dirOf(reference));
    expect(dump.includes("mpu-test-"), dump).toBe(true);
    expect(dump.endsWith(".dump"), dump).toBe(true);
  } finally {
    removeDumpFile(dump);
    rmSync(reference, { recursive: true });
  }
});

it("названные каталоги совпадают с правом задачи сборки", async () => {
  // Текст отказа перечисляет каталоги, а право их разрешает — два
  // места про одно. Сверка здесь: разойдясь, они дали бы оператору
  // совет, которого сборка не поддерживает.
  const denoJsonc = await readFile(
    new URL("../../../deno.jsonc", import.meta.url),
    "utf8",
  );
  // Имя задачи сборки названо один раз — у её единственного читателя.
  const task = denoJsonc.match(
    new RegExp(`"${BACK_TASK}":\\s*"([^"]*)"`),
  )?.[1] ?? "";
  const write = task.split(/\s+/)
    .find((arg) => arg.startsWith("--allow-write="))
    ?.slice("--allow-write=".length)
    .split(",") ?? [];
  for (const dir of DUMP_DIRS) {
    expect(write.includes(dir), `${dir} нет в --allow-write`).toBe(true);
  }
});

it("удаление временного файла: отсутствие файла — не отказ", () => {
  const path = makeDumpFile("mpu-test-");
  removeDumpFile(path);
  // Второе удаление того же пути молчит: упавший дамп мог не создать
  // файла вовсе, и уборка не должна ронять вызов поверх его отказа.
  removeDumpFile(path);
});

describe("настоящий запуск redis: подача, код возврата, причина отказа", () => {
  // Исходный дефект был в том, что настоящий исполнитель никем не
  // исполнялся и никем не проверялся. Проверяется он теми же
  // разрешёнными бинарями, что и подпроцесс ssh (`deno.jsonc`, задача
  // `test`), — живого docker в прогоне нет и не должно быть.
  it("успех: stdin принят, отказа нет", async () => {
    await spawnRedis(["/bin/echo", "проба"], "значение");
  });

  it("ненулевой код без stderr — причиной становится код", async () => {
    const err = await spawnRedis(["/bin/false"], "").catch((thrown: unknown) =>
      thrown
    );
    assert(err instanceof Error);
    expect(err.message).toBe("код 1");
  });

  it("процесс, не читающий ввод, не подменяет причину", async () => {
    // Ввод заведомо больше трубы (её буфер — десятки килобайт), а
    // `/bin/false` не читает ничего и выходит сразу. Пиши мы всё до
    // первого чтения — запись отвергло бы BrokenPipe, и наверх ушла бы
    // жалоба на трубу вместо настоящей причины отказа. Подача и чтение
    // идут одновременно, поэтому причиной остаётся код возврата.
    const err = await spawnRedis(["/bin/false"], "п".repeat(200_000)).catch((
      thrown: unknown,
    ) => thrown);
    assert(err instanceof Error);
    expect(err.message).toBe("код 1");
  });

  it("нечего запускать — отказ, а не тишина", async () => {
    // Отсутствие бинаря обязано дойти до вызывающего: шаг best-effort
    // превратит его в предупреждение, но решает это он, а не мы.
    await expect(spawnRedis(["/bin/net-takogo-binarya"], "")).rejects.toThrow();
  });
});

describe("отказ самого redis приходит в stdout при нулевом коде", () => {
  // Замер 2026-08-28: неверная арность и неизвестная команда дают код 0
  // и строку `ERR …` в stdout (stderr пуст). Не разбери мы её — шаг
  // молча не сделал бы ничего.
  it("строка ERR — отказ, хотя код нулевой", async () => {
    const err = await spawnRedis(
      ["/bin/echo", "ERR wrong number of arguments"],
      "",
    ).catch((thrown: unknown) => thrown);
    assert(err instanceof Error);
    expect(err.message).toBe("ERR wrong number of arguments");
  });

  it("форма с (error) тоже отказ", async () => {
    await expect(spawnRedis(["/bin/echo", "(error) ERR unknown command"], ""))
      .rejects.toThrow(Error);
  });

  it("обычный ответ отказом не считается", async () => {
    // `SET` и `FLUSHALL` отвечают `OK`; значение, начинающееся с `ERR`,
    // в stdout этих команд не появляется — они его не печатают.
    await spawnRedis(["/bin/echo", "OK"], "");
  });
});
