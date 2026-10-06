/**
 * Текст сообщения под пределом Telegram
 * (`docs/specs/platform/telegram-questions.md`, «Сообщение»).
 */

import { assertEquals } from "@std/assert";
import { Card, MESSAGE_LIMIT } from "./card.ts";

Deno.test("короткое тело — строки как есть, хвост последним", () => {
  const card = new Card("❓ Цвет · ozon", "Какой цвет?", ["• Синий — цвет"]);
  assertEquals(
    card.text(["ещё ждут: 2"]),
    "❓ Цвет · ozon\nКакой цвет?\n• Синий — цвет\nещё ждут: 2",
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
