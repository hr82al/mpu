/**
 * Блок диалога на снятом экране tmux (`claude-hook-notification-snapshot.md`,
 * «Вопрос-снимок», «Голдены → ожидаемые сообщения»): экраны сняты живьём
 * 2026-10-06, ожидаемые тела — литералы спеки.
 */

import { assertEquals } from "@std/assert";
import { dialogOf } from "./screen.ts";

const screen = (name: string) =>
  Deno.readTextFile(new URL(`testdata/snapshot/${name}`, import.meta.url));

Deno.test("R4-1: экран права Bash — тело и кнопки по спеке", async () => {
  const dialog = dialogOf(await screen("screen-permission-bash.txt"));
  assertEquals(dialog.lines(), [
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
  assertEquals(dialog.items(), [
    { number: 1, label: "1. Yes" },
    { number: 2, label: "2. Yes, and don’t ask again for: touch *" },
    { number: 3, label: "3. Yes, and switch to auto mode" },
    { number: 4, label: "4. No" },
  ]);
  assertEquals(dialog.waiting(), true);
});

Deno.test("R4-2: экран AskUserQuestion — разделитель внутри списка не начало блока; описание через « — »", async () => {
  const dialog = dialogOf(await screen("screen-ask-user-question.txt"));
  assertEquals(dialog.lines(), [
    "☐ Цвет",
    "Какой цвет?",
    "1. Красный — Красный цвет",
    "2. Синий — Синий цвет",
    "3. Type something.",
    "4. Chat about this",
  ]);
  assertEquals(dialog.items().map((item) => item.label), [
    "1. Красный",
    "2. Синий",
    "3. Type something.",
    "4. Chat about this",
  ]);
});

Deno.test("R4-3: экран формы MCP — тело по спеке, пунктов нет", async () => {
  const dialog = dialogOf(await screen("screen-elicitation-fields.txt"));
  assertEquals(dialog.lines(), [
    "MCP server “elicitprobe” requests your input",
    "ПРОБА-ФОРМА: применить?",
    "* Окружение: ▸ not set",
    "Принудительно: not set",
    "Заметка: not set",
    "Сколько: not set",
    "Accept    Decline",
  ]);
  assertEquals(dialog.items(), []);
  assertEquals(dialog.waiting(), true);
});

Deno.test("лента без диалога: пунктов и подсказок нет — не ждёт; первая строка — «лента», если блока нет", () => {
  const rule = "─".repeat(40);
  const dialog = dialogOf(
    `❯ привет\n● Ответ готов\n${rule}\n❯ \n${rule} probe ─\n`,
  );
  assertEquals(dialog.waiting(), false);
  assertEquals(dialogOf("просто текст\n").firstLine(), "лента");
});

Deno.test("подпись кнопки — до « · » и не длиннее 60", () => {
  const rule = "─".repeat(40);
  const long = "x".repeat(80);
  const dialog = dialogOf(`${rule}\nВопрос\n1. ${long}\nEsc to cancel\n`);
  assertEquals(dialog.items()[0].label.length, 60);
  assertEquals(dialog.items()[0].label.endsWith("…"), true);
});

Deno.test("копии экранов совпадают с каналом спецификаций", async () => {
  for (
    const name of [
      "screen-permission-bash.txt",
      "screen-ask-user-question.txt",
      "screen-elicitation-fields.txt",
      "settings-fragment-notification.json",
    ]
  ) {
    assertEquals(
      await Deno.readTextFile(
        new URL(`testdata/snapshot/${name}`, import.meta.url),
      ),
      await Deno.readTextFile(
        new URL(
          `../../../docs/specs/fixtures/telegram-relay/r4/${name}`,
          import.meta.url,
        ),
      ),
      name,
    );
  }
});
