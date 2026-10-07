/**
 * Блок диалога на снятом экране tmux (`claude-hook-notification-snapshot.md`,
 * «Вопрос-снимок», «Голдены → ожидаемые сообщения»): экраны сняты живьём
 * 2026-10-06, ожидаемые тела — литералы спеки.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { dialogOf } from "./screen.ts";

const screen = (name: string) =>
  readFile(new URL(`testdata/snapshot/${name}`, import.meta.url), "utf8");

it("R4-1: экран права Bash — тело и кнопки по спеке", async () => {
  const dialog = dialogOf(await screen("screen-permission-bash.txt"));
  expect(dialog.lines()).toStrictEqual([
    "Bash command",
    "Create empty probe file",
    "touch /home/user/mr/mp/ozon/s1.txt",
    "This command requires approval",
    "Do you want to proceed?",
    "1. Yes",
    "2. Yes, and don’t ask again for: touch *",
    "3. Yes, and switch to auto mode · auto mode handles these prompts for you",
    "4. No",
  ]);
  expect(dialog.items()).toStrictEqual([
    { number: 1, label: "1. Yes" },
    { number: 2, label: "2. Yes, and don’t ask again for: touch *" },
    { number: 3, label: "3. Yes, and switch to auto mode" },
    { number: 4, label: "4. No" },
  ]);
  expect(dialog.waiting()).toBe(true);
});

it("R4-2: экран AskUserQuestion — разделитель внутри списка не начало блока; описание через « — »", async () => {
  const dialog = dialogOf(await screen("screen-ask-user-question.txt"));
  expect(dialog.lines()).toStrictEqual([
    "☐ Цвет",
    "Какой цвет?",
    "1. Красный — Красный цвет",
    "2. Синий — Синий цвет",
    "3. Type something.",
    "4. Chat about this",
  ]);
  expect(dialog.items().map((item) => item.label)).toStrictEqual([
    "1. Красный",
    "2. Синий",
    "3. Type something.",
    "4. Chat about this",
  ]);
});

it("R4-3: экран формы MCP — тело по спеке, пунктов нет", async () => {
  const dialog = dialogOf(await screen("screen-elicitation-fields.txt"));
  expect(dialog.lines()).toStrictEqual([
    "MCP server “elicitprobe” requests your input",
    "ПРОБА-ФОРМА: применить?",
    "* Окружение: ▸ not set",
    "Принудительно: not set",
    "Заметка: not set",
    "Сколько: not set",
    "Accept    Decline",
  ]);
  expect(dialog.items()).toStrictEqual([]);
  expect(dialog.waiting()).toBe(true);
});

it("лента без диалога: пунктов и подсказок нет — не ждёт; первая строка — «лента», если блока нет", () => {
  const rule = "─".repeat(40);
  const dialog = dialogOf(
    `❯ привет\n● Ответ готов\n${rule}\n❯ \n${rule} probe ─\n`,
  );
  expect(dialog.waiting()).toBe(false);
  expect(dialogOf("просто текст\n").firstLine()).toBe("лента");
});

it("подпись кнопки — до « · » и не длиннее 60", () => {
  const rule = "─".repeat(40);
  const long = "x".repeat(80);
  const dialog = dialogOf(`${rule}\nВопрос\n1. ${long}\nEsc to cancel\n`);
  expect(dialog.items()[0].label.length).toBe(60);
  expect(dialog.items()[0].label.endsWith("…")).toBe(true);
});

it("копии экранов совпадают с каналом спецификаций", async () => {
  for (
    const name of [
      "screen-permission-bash.txt",
      "screen-ask-user-question.txt",
      "screen-elicitation-fields.txt",
      "settings-fragment-notification.json",
    ]
  ) {
    expect(
      await readFile(
        new URL(`testdata/snapshot/${name}`, import.meta.url),
        "utf8",
      ),
      name,
    ).toStrictEqual(
      await readFile(
        new URL(
          `../../../docs/specs/fixtures/telegram-relay/r4/${name}`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
});
