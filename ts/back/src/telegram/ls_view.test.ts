import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import type { Dialog } from "./chat.ts";
import { renderDialogsJson, renderDialogsTable } from "./ls_view.ts";

const DIALOGS: readonly Dialog[] = [
  { id: 100000001, title: "Иван Петров", kind: "user", username: "ipetrov" },
  { id: 100000002, title: "Бот сборок", kind: "bot", username: "build_bot" },
  {
    id: -1000000000003,
    title: "Канал релизов",
    kind: "channel",
    username: null,
  },
];

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/telegram-ls/${name}`, import.meta.url),
    "utf8",
  );
}

it("JSON: три диалога разных видов", async () => {
  expect(renderDialogsJson(DIALOGS)).toStrictEqual(
    await golden("ls-json-stdout.txt"),
  );
});

it("JSON: пустая выдача", async () => {
  expect(renderDialogsJson([])).toStrictEqual(
    await golden("ls-empty-stdout.txt"),
  );
});

it("JSON: юникод не экранируется", () => {
  expect(renderDialogsJson(DIALOGS).includes("\\u")).toBe(false);
});

it("таблица: пустая выдача — одна строка без счётчика", async () => {
  expect(renderDialogsTable([])).toStrictEqual(
    await golden("ls-empty-table-stdout.txt"),
  );
});

it("таблица: состав и порядок колонок", () => {
  const lines = renderDialogsTable(DIALOGS).split("\n");
  expect(lines[0].split(/\s+/).filter((cell) => cell !== "")).toStrictEqual([
    "ID",
    "KIND",
    "USERNAME",
    "TITLE",
  ]);
});

it("таблица: строки идут в порядке выдачи", () => {
  const lines = renderDialogsTable(DIALOGS).split("\n");
  expect(lines[1].startsWith("100000001")).toBe(true);
  expect(lines[2].startsWith("100000002")).toBe(true);
  expect(lines[3].startsWith("-1000000000003")).toBe(true);
});

it("таблица: у чата без имени пользователя колонка пуста", () => {
  const lines = renderDialogsTable(DIALOGS).split("\n");
  expect(lines[3].includes("null")).toBe(false);
  expect(lines[3].includes("Канал релизов")).toBe(true);
});

it("таблица: итог считает строки и оканчивает вывод", () => {
  const text = renderDialogsTable(DIALOGS);
  // Итог англоязычный при русском «(нет диалогов)» рядом — расхождение
  // сохранено осознанно (`telegram-ls.md`, вердикт preserve).
  expect(text.endsWith("(3 dialogs)\n")).toBe(true);
});
