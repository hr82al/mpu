/**
 * Подпись и данные кнопки (`docs/specs/platform/telegram-questions.md`,
 * «Сообщение», «Ответы владельца»).
 */

import { expect, it } from "vitest";
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

it("подпись: 60 символов — как есть, 61 — 59 и «…»", () => {
  expect(clipLabel("a".repeat(60))).toStrictEqual("a".repeat(60));
  expect(clipLabel("a".repeat(61))).toStrictEqual(`${"a".repeat(59)}…`);
  // Символ — кодовая точка: пара суррогатов не рвётся.
  expect(clipLabel("😀".repeat(61))).toStrictEqual(`${"😀".repeat(59)}…`);
});

it("данные кнопки: сборка и разбор туда и обратно", () => {
  const option = new ButtonData("r1", 7, 1, new OptionKey(2));
  expect(String(option)).toBe("r1:7:1:2");
  expect(ButtonData.parse("r1:7:1:2").pressOn("r1", 7, 1, STEP)).toBe(
    "вариант 2",
  );
  expect(String(new ButtonData("r1", 7, 0, DONE))).toBe("r1:7:0:ok");
  expect(ButtonData.parse("r1:7:0:ok").pressOn("r1", 7, 0, STEP)).toBe(
    "готово",
  );
  expect(String(new ButtonData("r1", 7, 0, LATER_KEY))).toBe("r1:7:0:later");
  expect(ButtonData.parse("r1:7:0:later").pressOn("r1", 7, 0, STEP)).toBe(
    "позже",
  );
  expect(String(new ButtonData("r1", 7, 0, SKIP_KEY))).toBe("r1:7:0:skip");
  expect(ButtonData.parse("r1:7:0:skip").pressOn("r1", 7, 0, STEP)).toBe(
    "пропустить",
  );
});

it("нажатие другого запуска, другого вопроса, другого шага или чужие данные — «вопрос уже решён»", () => {
  for (const data of [
    "r0:7:0:2",
    "r1:8:0:2",
    "r1:7:1:2",
    "r1:7:2",
    "q1:0",
    "",
    "R1:7:0:2",
    "r1:7:0:-1",
    "r1:7:0:Later",
  ]) {
    expect(
      ButtonData.parse(data).pressOn("r1", 7, 0, STEP),
      data,
    ).toStrictEqual(STALE);
  }
});

it("данные кнопки не длиннее 64 байт на худших значениях", () => {
  const worst = new ButtonData(
    "zzzzzzzz",
    Number.MAX_SAFE_INTEGER,
    3,
    new OptionKey(999),
  );
  const bytes = new TextEncoder().encode(String(worst)).length;
  expect(bytes <= 64, `${bytes} байт`).toBe(true);
  expect(
    ButtonData.parse(String(worst)).pressOn(
      "zzzzzzzz",
      Number.MAX_SAFE_INTEGER,
      3,
      STEP,
    ),
  ).toBe("вариант 999");
  const later = new ButtonData(
    "zzzzzzzz",
    Number.MAX_SAFE_INTEGER,
    3,
    LATER_KEY,
  );
  expect(new TextEncoder().encode(String(later)).length <= 64).toBe(true);
});
