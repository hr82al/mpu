/**
 * Память показанных сообщений в кэш-БД
 * (`docs/specs/platform/telegram-questions.md`, «Перезапуск»).
 */

import { assertEquals } from "@std/assert";
import { fakeConfigDb } from "../testing/mod.ts";
import { Card } from "./card.ts";
import { StoredMessages } from "./shown.ts";

Deno.test("запомнить, обновить, забыть — по номеру сообщения", () => {
  const shown = new StoredMessages(fakeConfigDb(), () => {});
  shown.remember(10, new Card("T", "шаг 1", []));
  shown.remember(11, new Card("U", "другой", []));
  shown.remember(10, new Card("T", "шаг 2", []));
  assertEquals(
    shown.all().map(({ id, body }) => [id, body.text([])]),
    [[10, "T\nшаг 2"], [11, "U\nдругой"]],
  );
  shown.forget(10);
  assertEquals(shown.all().map(({ id }) => id), [11]);
});

Deno.test("база недоступна — строка в журнал, вопрос не роняется", () => {
  const log: string[] = [];
  const shown = new StoredMessages(() => {
    throw new Error("нет HOME");
  }, (line) => log.push(line));
  shown.remember(1, new Card("T", "x", []));
  assertEquals(shown.all(), []);
  assertEquals(log, [
    "telegram: память вопросов: нет HOME",
    "telegram: память вопросов: нет HOME",
  ]);
});
