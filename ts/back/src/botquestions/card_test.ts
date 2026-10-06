/**
 * Текст сообщения под пределом Telegram
 * (`docs/specs/platform/telegram-questions.md`, «Сообщение»).
 */

import { assertEquals } from "@std/assert";
import { Card, KEEP_TAIL, MESSAGE_LIMIT } from "./card.ts";

Deno.test("короткое тело — строки как есть, хвост последним", () => {
  const card = new Card("❓ Цвет — ozon", "Какой цвет?", ["• Синий — цвет"]);
  assertEquals(
    card.text(["ещё ждут: 2"]),
    "❓ Цвет — ozon\nКакой цвет?\n• Синий — цвет\nещё ждут: 2",
  );
});

Deno.test("ровно предел — без усечения, на единицу длиннее — шаг усечён", () => {
  // Заголовок `T`, перевод строки, шаг: шаг занимает предел минус два.
  const exact = new Card("T", "x".repeat(MESSAGE_LIMIT - 2), []);
  assertEquals(exact.text([]).length, MESSAGE_LIMIT);
  assertEquals(exact.text([]).endsWith("x"), true);
  const over = new Card("T", "x".repeat(MESSAGE_LIMIT - 1), []);
  assertEquals(over.text([]).length, MESSAGE_LIMIT);
  assertEquals(over.text([]).endsWith("x…"), true);
});

Deno.test("усечение не рвёт суррогатную пару", () => {
  const card = new Card("T", "😀".repeat(MESSAGE_LIMIT), []);
  const text = card.text([]);
  assertEquals(text.length <= MESSAGE_LIMIT, true);
  assertEquals(text.endsWith("😀…"), true);
});

Deno.test("запись тела переживает разбор; битая — сообщение из одного хвоста", () => {
  const card = new Card("T", "шаг", ["• a — b"]);
  const parsed = Card.parse(JSON.stringify(card));
  assertEquals(parsed.text(["⌛"]), card.text(["⌛"]));
  for (
    const junk of [
      "",
      "{",
      "null",
      '{"title":1}',
      '{"title":"T","text":"x","lines":[1]}',
    ]
  ) {
    assertEquals(Card.parse(junk).text(["⌛ истёк"]), "⌛ истёк", junk);
  }
});

Deno.test("R2a-3: усечение с конца — первой строкой шага «…», конец текста цел", () => {
  const text = `${"а".repeat(8990)}Какой цвет?`;
  const card = new Card("💬 mpu-bot — ozon", text, [], KEEP_TAIL);
  const tail = "ответ — в терминале (сессия без канала)";
  const shown = card.text([tail]);
  assertEquals(shown.length, MESSAGE_LIMIT);
  const lines = shown.split("\n");
  assertEquals(lines[0], "💬 mpu-bot — ozon");
  assertEquals(lines[1], "…");
  assertEquals(lines.at(-2)?.endsWith("аКакой цвет?"), true);
  assertEquals(lines.at(-1), tail);
  assertEquals(
    new Card("T", "коротко", [], KEEP_TAIL).text([]),
    "T\nкоротко",
  );
});

Deno.test("R2a-3: усечение с конца не рвёт суррогатную пару", () => {
  const card = new Card("T", "😀".repeat(MESSAGE_LIMIT), [], KEEP_TAIL);
  const text = card.text([]);
  assertEquals(text.length <= MESSAGE_LIMIT, true);
  assertEquals(text.startsWith("T\n…\n😀"), true);
});

Deno.test("R2a-3: запись тела хранит, с какого конца усекать", () => {
  const card = new Card("T", "я".repeat(MESSAGE_LIMIT), [], KEEP_TAIL);
  const parsed = Card.parse(JSON.stringify(card));
  assertEquals(parsed.text(["⌛"]), card.text(["⌛"]));
});
