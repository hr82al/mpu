/**
 * Голдены схемы: чтение каталога и сверка состава
 * (`src/api/schema_golden.ts`).
 *
 * Проверяется то, что можно проверить без базы: что обходится весь
 * каталог, а не первый файл, и что расхождение видно по сторонам.
 * Саму сверку с живой `information_schema` делает `bun run smoke` при
 * поднятом стенде — здесь её нет и быть не может.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  columnsOf,
  compareColumns,
  schemaCheckPlan,
  schemaGoldens,
  skipReason,
} from "./schema_golden.ts";
import { makeFakeIo } from "../testing/mod.ts";

it("обходится весь каталог, а не первый файл", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await writeFile(`${dir}/первая.columns`, "a\nb\n");
    await writeFile(`${dir}/вторая.columns`, "c\n");
    // Посторонний файл каталога голденом не считается.
    await writeFile(`${dir}/заметка.txt`, "не голден\n");
    const goldens = await schemaGoldens(new URL(`file://${dir}/`));
    // Два, а не один: молчаливый предел «берём первый» не виден тому,
    // кто положит второй голден.
    expect(goldens.map((one) => one.table)).toStrictEqual(["вторая", "первая"]);
    expect(goldens[1].columns).toStrictEqual(["a", "b"]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("настоящий каталог непуст и содержит известную таблицу", async () => {
  const goldens = await schemaGoldens();
  expect(goldens.length > 0).toBe(true);
  const grants = goldens.find((one) =>
    one.table === "spreadsheets_access_grants"
  );
  // Ключ выдачи зовётся `grant_id`; колонки `id` в таблице нет вовсе
  // (замер порции 79, из-за которого голден и появился).
  expect(grants?.columns.includes("grant_id")).toBe(true);
  expect(grants?.columns.includes("id")).toBe(false);
});

it("пустые строки и пробелы голден не засоряют", () => {
  expect(columnsOf("a\n\n  b  \n\n")).toStrictEqual(["a", "b"]);
});

describe("расхождение видно по сторонам", () => {
  it("совпало — обе стороны пусты", () => {
    expect(compareColumns(["a", "b"], ["b", "a"])).toStrictEqual({
      missing: [],
      extra: [],
    });
  });

  it("колонки нет в базе — это missing", () => {
    // Ломает запрос сегодня: команда пойдёт в несуществующую колонку.
    expect(compareColumns(["a", "id"], ["a"])).toStrictEqual({
      missing: ["id"],
      extra: [],
    });
  });

  it("колонка появилась в базе — это extra", () => {
    // Не ломает ничего, но означает, что снимок устарел; чинится
    // пересъёмом, а не правкой кода.
    expect(compareColumns(["a"], ["a", "новая"])).toStrictEqual({
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

describe("план сверки: пропуск и проверка — разные исходы", () => {
  it("нет реквизитов — пропуск с причиной", () => {
    const plan = schemaCheckPlan(envOf({}));
    // Пропуск обязан оставаться пропуском: подменить его зелёным
    // значило бы выдать «не с чем сверять» за «сверили и сошлось».
    expect(plan.kind).toBe("skip");
    expect(
      plan.kind === "skip" && plan.reason.includes("pg_0"),
      "причина не называет недостающий ключ",
    ).toBe(true);
  });

  it("реквизиты есть — сверяем", () => {
    const plan = schemaCheckPlan(envOf({
      pg_0: "127.0.0.1",
      PG_MAIN_USER_NAME: "u",
      PG_MAIN_USER_PASSWORD: "p",
    }));
    expect(plan.kind).toBe("check");
    expect(plan.kind === "check" && plan.target.host).toBe("127.0.0.1");
  });
});

describe("причины пропуска различимы и лечатся в разных местах", () => {
  it("текст называет и причину, и место починки", () => {
    const unreachable = skipReason("unreachable", "ECONNREFUSED");
    expect(unreachable).toContain("стенд не поднят");
    const credentials = skipReason("credentials", "pg_0 is not set");
    expect(credentials).toContain("реквизиты");
    // Две причины — два разных текста: сведённые к одному, они отправят
    // читателя чинить не то.
    expect(new Set([unreachable, credentials]).size).toBe(2);
  });
});
