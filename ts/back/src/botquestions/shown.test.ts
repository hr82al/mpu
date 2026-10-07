/**
 * Память показанных сообщений в кэш-БД
 * (`docs/specs/platform/telegram-questions.md`, «Перезапуск»).
 */

import { expect, it } from "vitest";
import { fakeConfigDb } from "../testing/mod.ts";
import { Card } from "./card.ts";
import { StoredMessages } from "./shown.ts";

it("запомнить, обновить, забыть — по номеру сообщения", () => {
  const shown = new StoredMessages(fakeConfigDb(), () => {});
  shown.remember(10, new Card("T", "шаг 1", []));
  shown.remember(11, new Card("U", "другой", []));
  shown.remember(10, new Card("T", "шаг 2", []));
  expect(shown.all().map(({ id, body }) => [id, body.text([])])).toStrictEqual([
    [10, "T\nшаг 2"],
    [11, "U\nдругой"],
  ]);
  shown.forget(10);
  expect(shown.all().map(({ id }) => id)).toStrictEqual([11]);
});

it("база недоступна — строка в журнал, вопрос не роняется", () => {
  const log: string[] = [];
  const shown = new StoredMessages(
    () => {
      throw new Error("нет HOME");
    },
    (line) => log.push(line),
  );
  shown.remember(1, new Card("T", "x", []));
  expect(shown.all()).toStrictEqual([]);
  expect(log).toStrictEqual([
    "telegram: память вопросов: нет HOME",
    "telegram: память вопросов: нет HOME",
  ]);
});
