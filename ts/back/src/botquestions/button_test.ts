/**
 * Подпись и данные кнопки (`docs/specs/platform/telegram-questions.md`,
 * «Сообщение», «Ответы владельца»).
 */

import { assertEquals } from "@std/assert";
import {
  ButtonData,
  clipLabel,
  DONE,
  LATER_KEY,
  OptionKey,
  type Pressable,
  SKIP_KEY,
  STALE,
} from "./button.ts";

/** Вопрос, называющий нажатое. */
const STEP: Pressable = {
  pick: (index) => `вариант ${index}`,
  done: () => "готово",
  later: () => "позже",
  skip: () => "пропустить",
};

Deno.test("подпись: 60 символов — как есть, 61 — 59 и «…»", () => {
  assertEquals(clipLabel("a".repeat(60)), "a".repeat(60));
  assertEquals(clipLabel("a".repeat(61)), `${"a".repeat(59)}…`);
  // Символ — кодовая точка: пара суррогатов не рвётся.
  assertEquals(clipLabel("😀".repeat(61)), `${"😀".repeat(59)}…`);
});

Deno.test("данные кнопки: сборка и разбор туда и обратно", () => {
  const option = new ButtonData("r1", 7, 1, new OptionKey(2));
  assertEquals(String(option), "r1:7:1:2");
  assertEquals(
    ButtonData.parse("r1:7:1:2").pressOn("r1", 7, 1, STEP),
    "вариант 2",
  );
  assertEquals(String(new ButtonData("r1", 7, 0, DONE)), "r1:7:0:ok");
  assertEquals(
    ButtonData.parse("r1:7:0:ok").pressOn("r1", 7, 0, STEP),
    "готово",
  );
  assertEquals(String(new ButtonData("r1", 7, 0, LATER_KEY)), "r1:7:0:later");
  assertEquals(
    ButtonData.parse("r1:7:0:later").pressOn("r1", 7, 0, STEP),
    "позже",
  );
  assertEquals(String(new ButtonData("r1", 7, 0, SKIP_KEY)), "r1:7:0:skip");
  assertEquals(
    ButtonData.parse("r1:7:0:skip").pressOn("r1", 7, 0, STEP),
    "пропустить",
  );
});

Deno.test("нажатие другого запуска, другого вопроса, другого шага или чужие данные — «вопрос уже решён»", () => {
  for (
    const data of [
      "r0:7:0:2",
      "r1:8:0:2",
      "r1:7:1:2",
      "r1:7:2",
      "q1:0",
      "",
      "R1:7:0:2",
      "r1:7:0:-1",
      "r1:7:0:Later",
    ]
  ) {
    assertEquals(ButtonData.parse(data).pressOn("r1", 7, 0, STEP), STALE, data);
  }
});

Deno.test("данные кнопки не длиннее 64 байт на худших значениях", () => {
  const worst = new ButtonData(
    "zzzzzzzz",
    Number.MAX_SAFE_INTEGER,
    3,
    new OptionKey(999),
  );
  const bytes = new TextEncoder().encode(String(worst)).length;
  assertEquals(bytes <= 64, true, `${bytes} байт`);
  assertEquals(
    ButtonData.parse(String(worst)).pressOn(
      "zzzzzzzz",
      Number.MAX_SAFE_INTEGER,
      3,
      STEP,
    ),
    "вариант 999",
  );
  const later = new ButtonData(
    "zzzzzzzz",
    Number.MAX_SAFE_INTEGER,
    3,
    LATER_KEY,
  );
  assertEquals(new TextEncoder().encode(String(later)).length <= 64, true);
});
