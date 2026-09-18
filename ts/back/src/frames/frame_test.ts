import { assertEquals, assertThrows } from "@std/assert";
import { BadFrame, serverFrameOf, ticketAnswerOf } from "./mod.ts";

Deno.test("кадр сервера: четыре вида и отказ прочему", async (t) => {
  for (
    const frame of [{ out: "a" }, { err: "b" }, { ask: "c? " }, { exit: 2 }]
  ) {
    await t.step(JSON.stringify(frame), () => {
      assertEquals(serverFrameOf(JSON.stringify(frame)), frame);
    });
  }
  for (
    const bad of [
      "{",
      "[]",
      '{"exit":"0"}',
      '{"exit":1.5}',
      '{"out":1}',
      '{"out":"a","err":"b"}',
      '{"what":"x"}',
    ]
  ) {
    await t.step(bad, () => {
      assertThrows(() => serverFrameOf(bad), BadFrame);
    });
  }
});

Deno.test("тело ответа по номеру: номер и ответ, мусор — пусто", async (t) => {
  const cases:
    readonly (readonly [string, { ticket: string; answer: string }])[] = [
      ['{"ticket":"ab","answer":"y"}', { ticket: "ab", answer: "y" }],
      ['{"ticket":"ab"}', { ticket: "ab", answer: "" }],
      ['{"ticket":1,"answer":true}', { ticket: "", answer: "" }],
      ["[]", { ticket: "", answer: "" }],
      ["{", { ticket: "", answer: "" }],
    ];
  for (const [text, expected] of cases) {
    await t.step(text, () => assertEquals(ticketAnswerOf(text), expected));
  }
});
