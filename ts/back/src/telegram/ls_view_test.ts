import { assertEquals } from "@std/assert";
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
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-ls/${name}`, import.meta.url),
  );
}

Deno.test("JSON: три диалога разных видов", async () => {
  assertEquals(renderDialogsJson(DIALOGS), await golden("ls-json-stdout.txt"));
});

Deno.test("JSON: пустая выдача", async () => {
  assertEquals(renderDialogsJson([]), await golden("ls-empty-stdout.txt"));
});

Deno.test("JSON: юникод не экранируется", () => {
  assertEquals(renderDialogsJson(DIALOGS).includes("\\u"), false);
});

Deno.test("таблица: пустая выдача — одна строка без счётчика", async () => {
  assertEquals(
    renderDialogsTable([]),
    await golden("ls-empty-table-stdout.txt"),
  );
});

Deno.test("таблица: состав и порядок колонок", () => {
  const lines = renderDialogsTable(DIALOGS).split("\n");
  assertEquals(lines[0].split(/\s+/).filter((cell) => cell !== ""), [
    "ID",
    "KIND",
    "USERNAME",
    "TITLE",
  ]);
});

Deno.test("таблица: строки идут в порядке выдачи", () => {
  const lines = renderDialogsTable(DIALOGS).split("\n");
  assertEquals(lines[1].startsWith("100000001"), true);
  assertEquals(lines[2].startsWith("100000002"), true);
  assertEquals(lines[3].startsWith("-1000000000003"), true);
});

Deno.test("таблица: у чата без имени пользователя колонка пуста", () => {
  const lines = renderDialogsTable(DIALOGS).split("\n");
  assertEquals(lines[3].includes("null"), false);
  assertEquals(lines[3].includes("Канал релизов"), true);
});

Deno.test("таблица: итог считает строки и оканчивает вывод", () => {
  const text = renderDialogsTable(DIALOGS);
  // Итог англоязычный при русском «(нет диалогов)» рядом — расхождение
  // сохранено осознанно (`telegram-ls.md`, вердикт preserve).
  assertEquals(text.endsWith("(3 dialogs)\n"), true);
});
