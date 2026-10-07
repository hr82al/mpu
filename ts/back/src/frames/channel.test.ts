/**
 * Кадры канала Claude Code ↔ ядро (`claude-channel.md`, «Регистрация в
 * ядре»): запись и разбор — одна форма у обеих сторон.
 */

import { expect, it } from "vitest";
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

it("первый кадр канала — ключ сессии; пустой или чужой — нет ключа", () => {
  const key = "/run/user/1000/cc-socks/42.sock";
  expect(helloKeyOf(helloFrame(key))).toStrictEqual(key);
  for (const junk of ["", "{", "[]", '{"key":""}', '{"key":1}', "null"]) {
    expect(helloKeyOf(junk), junk).toStrictEqual(undefined);
  }
});

it("кадр ядра «доставить» — туда и обратно; не той формы — чужой", () => {
  expect(readCoreFrame(deliverFrame(7, "Синий"), CORE)).toBe(
    "доставить 7: Синий",
  );
  expect(readCoreFrame(READY_FRAME, CORE)).toBe("готов");
  expect(readCoreFrame('{"ready":false}', CORE)).toBe("чужой");
  expect(deliverFrame(7, "Синий")).toBe('{"deliver":"Синий","id":7}');
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
    expect(readCoreFrame(junk, CORE), junk).toBe("чужой");
  }
});

it("ответ канала — доставлено или отказ по номеру; не той формы — чужой", () => {
  expect(readChannelAnswer(deliveredFrame(3), ANSWER)).toBe("доставлено 3");
  expect(readChannelAnswer(failedFrame(3), ANSWER)).toBe("отказ 3");
  for (const junk of ["", "{}", '{"delivered":"3"}', '{"failed":-2}']) {
    expect(readChannelAnswer(junk, ANSWER), junk).toBe("чужой");
  }
});
