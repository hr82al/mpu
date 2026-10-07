/**
 * Текст сообщения под пределом Telegram
 * (`docs/specs/platform/telegram-questions.md`, «Сообщение»).
 */

import { expect, it } from "vitest";
import {
  BOLD_FIRST_LINE,
  Card,
  KEEP_TAIL,
  MESSAGE_LIMIT,
  preformatted,
} from "./card.ts";

it("короткое тело — строки как есть, хвост последним", () => {
  const card = new Card("❓ Цвет — ozon", "Какой цвет?", ["• Синий — цвет"]);
  expect(card.text(["ещё ждут: 2"])).toBe(
    "❓ Цвет — ozon\nКакой цвет?\n• Синий — цвет\nещё ждут: 2",
  );
});

it("ровно предел — без усечения, на единицу длиннее — шаг усечён", () => {
  // Заголовок `T`, перевод строки, шаг: шаг занимает предел минус два.
  const exact = new Card("T", "x".repeat(MESSAGE_LIMIT - 2), []);
  expect(exact.text([]).length).toStrictEqual(MESSAGE_LIMIT);
  expect(exact.text([]).endsWith("x")).toBe(true);
  const over = new Card("T", "x".repeat(MESSAGE_LIMIT - 1), []);
  expect(over.text([]).length).toStrictEqual(MESSAGE_LIMIT);
  expect(over.text([]).endsWith("x…")).toBe(true);
});

it("усечение не рвёт суррогатную пару", () => {
  const card = new Card("T", "😀".repeat(MESSAGE_LIMIT), []);
  const text = card.text([]);
  expect(text.length <= MESSAGE_LIMIT).toBe(true);
  expect(text.endsWith("😀…")).toBe(true);
});

it("запись тела переживает разбор; битая — сообщение из одного хвоста", () => {
  const card = new Card("T", "шаг", ["• a — b"]);
  const parsed = Card.parse(JSON.stringify(card));
  expect(parsed.text(["⌛"])).toStrictEqual(card.text(["⌛"]));
  for (const junk of [
    "",
    "{",
    "null",
    '{"title":1}',
    '{"title":"T","text":"x","lines":[1]}',
  ]) {
    expect(Card.parse(junk).text(["⌛ истёк"]), junk).toBe("⌛ истёк");
  }
});

it("R2a-3: усечение с конца — первой строкой шага «…», конец текста цел", () => {
  const text = `${"а".repeat(8990)}Какой цвет?`;
  const card = new Card("💬 mpu-bot — ozon", text, [], KEEP_TAIL);
  const tail = "ответ — в терминале (сессия без канала)";
  const shown = card.text([tail]);
  expect(shown.length).toStrictEqual(MESSAGE_LIMIT);
  const lines = shown.split("\n");
  expect(lines[0]).toBe("💬 mpu-bot — ozon");
  expect(lines[1]).toBe("…");
  expect(lines.at(-2)?.endsWith("аКакой цвет?")).toBe(true);
  expect(lines.at(-1)).toStrictEqual(tail);
  expect(new Card("T", "коротко", [], KEEP_TAIL).text([])).toBe("T\nкоротко");
});

it("R2a-3: усечение с конца не рвёт суррогатную пару", () => {
  const card = new Card("T", "😀".repeat(MESSAGE_LIMIT), [], KEEP_TAIL);
  const text = card.text([]);
  expect(text.length <= MESSAGE_LIMIT).toBe(true);
  expect(text.startsWith("T\n…\n😀")).toBe(true);
});

it("R2a-3: запись тела хранит, с какого конца усекать", () => {
  const card = new Card("T", "я".repeat(MESSAGE_LIMIT), [], KEEP_TAIL);
  const parsed = Card.parse(JSON.stringify(card));
  expect(parsed.text(["⌛"])).toStrictEqual(card.text(["⌛"]));
});

it("запись тела до R2 (без поля clip) — остаётся начало, как прежде", () => {
  const old = JSON.stringify({
    title: "T",
    text: "я".repeat(MESSAGE_LIMIT),
    lines: [],
  });
  expect(Card.parse(old).text([])).toStrictEqual(
    new Card("T", "я".repeat(MESSAGE_LIMIT), []).text([]),
  );
  expect(Card.parse(old).text([]).endsWith("я…")).toBe(true);
});

it("R4: первая строка шага — жирным; смещение — в UTF-16 после заголовка", () => {
  const card = new Card(
    "🖥 probe — ozon",
    "Bash command\nDo you want to proceed?",
    [],
    KEEP_TAIL,
    BOLD_FIRST_LINE,
  );
  const shown = card.render(["ещё ждут: 1"]);
  expect(shown.entities).toStrictEqual([
    {
      type: "bold",
      offset: 16,
      length: 12,
    },
  ]);
  expect(shown.text.slice(16, 28)).toBe("Bash command");
  // Хвост исхода — тоже с выделением: правка без него его сняла бы.
  expect(card.render(["✅ готово"]).entities.length).toBe(1);
});

it("R4: блок усечён с начала — первой строки нет, выделения нет", () => {
  const card = new Card(
    "T",
    `первая\n${"я".repeat(MESSAGE_LIMIT)}`,
    [],
    KEEP_TAIL,
    BOLD_FIRST_LINE,
  );
  const shown = card.render([]);
  expect(shown.text.split("\n")[1]).toBe("…");
  expect(shown.entities).toStrictEqual([]);
});

it("R4: весь экран — моноширинным блоком целиком; длиннее предела — конец", () => {
  expect(preformatted("a\nb")).toStrictEqual({
    text: "a\nb",
    entities: [{ type: "pre", offset: 0, length: 3 }],
  });
  const long = preformatted(`${"x".repeat(MESSAGE_LIMIT)}\nдиалог`);
  expect(long.text.length <= MESSAGE_LIMIT).toBe(true);
  expect(long.text.endsWith("\nдиалог")).toBe(true);
  expect(long.entities[0].length).toStrictEqual(long.text.length);
});
