import { assertEquals, assertThrows } from "@std/assert";
import { BadFrame, serverFrameOf } from "./mod.ts";

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
