/**
 * Кадры канала Claude Code ↔ ядро (`claude-channel.md`, «Регистрация в
 * ядре»): запись и разбор — одна форма у обеих сторон.
 */

import { assertEquals } from "@std/assert";
import {
  type ChannelAnswerReader,
  type CoreFrameReader,
  deliveredFrame,
  deliverFrame,
  failedFrame,
  helloFrame,
  helloKeyOf,
  readChannelAnswer,
  readCoreFrame,
  READY_FRAME,
} from "./channel.ts";

const CORE: CoreFrameReader<string> = {
  ready: () => "готов",
  deliver: (id, text) => `доставить ${id}: ${text}`,
  unknown: () => "чужой",
};

const ANSWER: ChannelAnswerReader<string> = {
  delivered: (id) => `доставлено ${id}`,
  failed: (id) => `отказ ${id}`,
  unknown: () => "чужой",
};

Deno.test("первый кадр канала — ключ сессии; пустой или чужой — нет ключа", () => {
  const key = "/run/user/1000/cc-socks/42.sock";
  assertEquals(helloKeyOf(helloFrame(key)), key);
  for (const junk of ["", "{", "[]", '{"key":""}', '{"key":1}', "null"]) {
    assertEquals(helloKeyOf(junk), undefined, junk);
  }
});

Deno.test("кадр ядра «доставить» — туда и обратно; не той формы — чужой", () => {
  assertEquals(
    readCoreFrame(deliverFrame(7, "Синий"), CORE),
    "доставить 7: Синий",
  );
  assertEquals(readCoreFrame(READY_FRAME, CORE), "готов");
  assertEquals(readCoreFrame('{"ready":false}', CORE), "чужой");
  assertEquals(deliverFrame(7, "Синий"), '{"deliver":"Синий","id":7}');
  for (
    const junk of [
      "",
      "{",
      '{"deliver":"x"}',
      '{"deliver":1,"id":1}',
      '{"deliver":"x","id":-1}',
      '{"deliver":"x","id":1.5}',
    ]
  ) {
    assertEquals(readCoreFrame(junk, CORE), "чужой", junk);
  }
});

Deno.test("ответ канала — доставлено или отказ по номеру; не той формы — чужой", () => {
  assertEquals(readChannelAnswer(deliveredFrame(3), ANSWER), "доставлено 3");
  assertEquals(readChannelAnswer(failedFrame(3), ANSWER), "отказ 3");
  for (const junk of ["", "{}", '{"delivered":"3"}', '{"failed":-2}']) {
    assertEquals(readChannelAnswer(junk, ANSWER), "чужой", junk);
  }
});
