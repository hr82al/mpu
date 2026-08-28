/**
 * Голдены схемы: чтение каталога и сверка состава
 * (`src/api/schema_golden.ts`).
 *
 * Проверяется то, что можно проверить без базы: что обходится весь
 * каталог, а не первый файл, и что расхождение видно по сторонам.
 * Саму сверку с живой `information_schema` делает `deno task smoke` при
 * поднятом стенде — здесь её нет и быть не может.
 */

import { assertEquals } from "@std/assert";
import {
  columnsOf,
  compareColumns,
  schemaCheckPlan,
  schemaGoldens,
} from "./schema_golden.ts";
import { makeFakeIo } from "../testing/mod.ts";

Deno.test("обходится весь каталог, а не первый файл", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/первая.columns`, "a\nb\n");
    await Deno.writeTextFile(`${dir}/вторая.columns`, "c\n");
    // Посторонний файл каталога голденом не считается.
    await Deno.writeTextFile(`${dir}/заметка.txt`, "не голден\n");
    const goldens = await schemaGoldens(new URL(`file://${dir}/`));
    // Два, а не один: молчаливый предел «берём первый» не виден тому,
    // кто положит второй голден.
    assertEquals(goldens.map((one) => one.table), ["вторая", "первая"]);
    assertEquals(goldens[1].columns, ["a", "b"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("настоящий каталог непуст и содержит известную таблицу", async () => {
  const goldens = await schemaGoldens();
  assertEquals(goldens.length > 0, true);
  const grants = goldens.find((one) =>
    one.table === "spreadsheets_access_grants"
  );
  // Ключ выдачи зовётся `grant_id`; колонки `id` в таблице нет вовсе
  // (замер порции 79, из-за которого голден и появился).
  assertEquals(grants?.columns.includes("grant_id"), true);
  assertEquals(grants?.columns.includes("id"), false);
});

Deno.test("пустые строки и пробелы голден не засоряют", () => {
  assertEquals(columnsOf("a\n\n  b  \n\n"), ["a", "b"]);
});

Deno.test("расхождение видно по сторонам", async (t) => {
  await t.step("совпало — обе стороны пусты", () => {
    assertEquals(compareColumns(["a", "b"], ["b", "a"]), {
      missing: [],
      extra: [],
    });
  });

  await t.step("колонки нет в базе — это missing", () => {
    // Ломает запрос сегодня: команда пойдёт в несуществующую колонку.
    assertEquals(compareColumns(["a", "id"], ["a"]), {
      missing: ["id"],
      extra: [],
    });
  });

  await t.step("колонка появилась в базе — это extra", () => {
    // Не ломает ничего, но означает, что снимок устарел; чинится
    // пересъёмом, а не правкой кода.
    assertEquals(compareColumns(["a"], ["a", "новая"]), {
      missing: [],
      extra: ["новая"],
    });
  });
});

/** Порт с заданными ключами env-файла и ничем больше. */
function envOf(values: Readonly<Record<string, string>>) {
  return makeFakeIo({
    envFile: {
      get: (name: string) => values[name],
      require: (name: string) => {
        const value = values[name];
        if (value === undefined) {
          throw new Error(
            `environment variable ${name} is not set. Add it to ~/.config/mpu/.env`,
          );
        }
        return value;
      },
      set: () => Promise.reject(new Error("запись не ожидается")),
      values: () => ({ ...values }),
    },
  }).envFile;
}

Deno.test("план сверки: пропуск и проверка — разные исходы", async (t) => {
  await t.step("нет реквизитов — пропуск с причиной", () => {
    const plan = schemaCheckPlan(envOf({}));
    // Пропуск обязан оставаться пропуском: подменить его зелёным
    // значило бы выдать «не с чем сверять» за «сверили и сошлось».
    assertEquals(plan.kind, "skip");
    assertEquals(
      plan.kind === "skip" && plan.reason.includes("pg_0"),
      true,
      "причина не называет недостающий ключ",
    );
  });

  await t.step("реквизиты есть — сверяем", () => {
    const plan = schemaCheckPlan(envOf({
      pg_0: "127.0.0.1",
      PG_MAIN_USER_NAME: "u",
      PG_MAIN_USER_PASSWORD: "p",
    }));
    assertEquals(plan.kind, "check");
    assertEquals(plan.kind === "check" && plan.target.host, "127.0.0.1");
  });
});
