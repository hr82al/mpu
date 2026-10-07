import { beforeAll, describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import {
  BadFrame,
  type Collected,
  collectedOf,
  lineRequest,
  type PictureMime,
  type ServerFrame,
  serverFrameOf,
  stdinOf,
  ticketAnswerOf,
} from "./mod.ts";

describe("кадр сервера: шесть видов и отказ прочему", () => {
  const frames: readonly ServerFrame[] = [
    { out: "a" },
    { err: "b" },
    { ask: "c? " },
    { settled: "решено в Telegram — да" },
    { stdinRequest: true },
    { exit: 2 },
  ];
  for (const frame of frames) {
    it(JSON.stringify(frame), () => {
      expect(serverFrameOf(JSON.stringify(frame))).toStrictEqual(frame);
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
      '{"stdinRequest":false}',
      '{"stdinRequest":"yes"}',
      '{"settled":true}',
    ]
  ) {
    it(bad, () => {
      expect(() => serverFrameOf(bad)).toThrow(BadFrame);
    });
  }
});

it("кадр ввода клиента: строка stdin, прочее — не ввод", () => {
  expect(stdinOf('{"stdin":"x"}')).toBe("x");
  expect(stdinOf('{"stdin":""}')).toBe("");
  for (const other of ['{"stdin":1}', '{"answer":"y"}', "{", "[]", 7]) {
    expect(stdinOf(other)).toStrictEqual(undefined);
  }
});

describe("кадр отказа: объект доезжает, поле не своего вида — отказ", () => {
  const refusal = {
    reason: "не понимает",
    hint: ["kiten"],
    candidates: ["kiten"],
    text: "mpu: не понимает kitn; ближайшие: kiten",
  };
  const bare = { ...refusal, hint: null, candidates: [] };
  beforeAll(() => {
    expect(serverFrameOf(JSON.stringify({ refusal }))).toStrictEqual({
      refusal,
    });
    expect(serverFrameOf(JSON.stringify({ refusal: bare }))).toStrictEqual({
      refusal: bare,
    });
    expect(
      collectedOf(
        JSON.stringify({ stdout: "", stderr: "x", exit: 2, refusal }),
      ),
    ).toStrictEqual({ stdout: "", stderr: "x", exit: 2, refusal });
  });
  for (
    const bad of [
      '{"refusal":"x"}',
      '{"refusal":{"reason":"r","hint":"kiten","candidates":[],"text":"t"}}',
      '{"refusal":{"reason":"r","hint":[1],"candidates":[],"text":"t"}}',
      '{"refusal":{"reason":"r","hint":null,"candidates":null,"text":"t"}}',
      '{"refusal":{"reason":1,"hint":null,"candidates":[],"text":"t"}}',
      '{"refusal":{"reason":"r","hint":null,"candidates":[]}}',
    ]
  ) {
    it(bad, () => {
      expect(() => serverFrameOf(bad)).toThrow(BadFrame);
    });
  }
});

describe("вид вопроса: secret доезжает, line опускается, чужое — отказ", () => {
  const kept: ServerFrame = { ask: "Пароль: ", kind: "secret" };
  beforeAll(() => {
    expect(serverFrameOf(JSON.stringify(kept))).toStrictEqual(kept);
    expect(serverFrameOf('{"ask":"q? ","kind":"line"}')).toStrictEqual({
      ask: "q? ",
    });
  });
  for (
    const bad of [
      '{"ask":"q? ","kind":"Secret"}',
      '{"ask":"q? ","kind":"menu"}',
      '{"ask":"q? ","kind":1}',
    ]
  ) {
    // Чужой вид — плохой кадр, а не молчаливое «видимый»: скрытое не
    // должно становиться видимым по ошибке.
    it(bad, () => {
      expect(() => serverFrameOf(bad)).toThrow(BadFrame);
    });
  }
});

describe("тело ответа по номеру: номер и ответ, мусор — пусто", () => {
  const cases:
    readonly (readonly [string, { ticket: string; answer: string }])[] = [
      ['{"ticket":"ab","answer":"y"}', { ticket: "ab", answer: "y" }],
      ['{"ticket":"ab"}', { ticket: "ab", answer: "" }],
      ['{"ticket":1,"answer":true}', { ticket: "", answer: "" }],
      ["[]", { ticket: "", answer: "" }],
      ["{", { ticket: "", answer: "" }],
    ];
  for (const [text, expected] of cases) {
    it(text, () => expect(ticketAnswerOf(text)).toStrictEqual(expected));
  }
});

describe("собранный ответ: итог кодом или вопросом, прочее — отказ", () => {
  const exited = { stdout: "a", stderr: "b", exit: 0 };
  const asked = { stdout: "", stderr: "", ask: "q? ", ticket: "ab" };
  // Вид вопроса доезжает и собранным ответом: иначе скрытый ответ
  // читался бы с эхом (`platform/line-prompt.md`).
  const secret: Collected = { ...asked, kind: "secret" };
  beforeAll(() => {
    expect(collectedOf(JSON.stringify(exited))).toStrictEqual(exited);
    expect(collectedOf(JSON.stringify(asked))).toStrictEqual(asked);
    expect(collectedOf(JSON.stringify(secret))).toStrictEqual(secret);
    expect(collectedOf(JSON.stringify({ ...asked, kind: "line" })))
      .toStrictEqual(
        asked,
      );
  });
  for (
    const bad of [
      "{",
      "[]",
      '{"stdout":"a"}',
      '{"stdout":"","stderr":""}',
      '{"stdout":"","stderr":"","ask":"q? ","kind":"menu","ticket":"ab"}',
    ]
  ) {
    it(bad, () => {
      expect(() => collectedOf(bad)).toThrow(BadFrame);
    });
  }
});

describe("собранный ответ: вывод файлом вместо stdout", () => {
  const file = {
    path: "/tmp/mpu-out/r.txt",
    bytes: 70000,
    lines: 9,
    slice: true,
  };
  beforeAll(() => {
    expect(collectedOf(JSON.stringify({ file, stderr: "", exit: 0 })))
      .toStrictEqual({ stdout: "", stderr: "", exit: 0, file });
  });
  for (
    const bad of [
      JSON.stringify({ stdout: "a", file, stderr: "", exit: 0 }),
      JSON.stringify({ file, exit: 0 }),
      JSON.stringify({ file: "x", stderr: "", exit: 0 }),
      JSON.stringify({ file: { ...file, bytes: "1" }, stderr: "", exit: 0 }),
      JSON.stringify({ file: { ...file, lines: 1.5 }, stderr: "", exit: 0 }),
      JSON.stringify({ file: { ...file, slice: 1 }, stderr: "", exit: 0 }),
      JSON.stringify({ file: { ...file, path: 1 }, stderr: "", exit: 0 }),
    ]
  ) {
    it(bad, () => {
      expect(() => collectedOf(bad)).toThrow(BadFrame);
    });
  }
});

it("первый кадр: caller — строка или нет поля", () => {
  const base = { words: ["it"], cwd: "/" };
  expect(lineRequest(JSON.stringify(base)).caller).toStrictEqual(undefined);
  expect(lineRequest(JSON.stringify({ ...base, caller: "ppid:7" })).caller)
    .toBe("ppid:7");
  const err = thrown(
    () => lineRequest(JSON.stringify({ ...base, caller: 7 })),
    BadFrame,
  );
  expect(err.message).toBe("caller — не строка");
});

describe("кадр картинки: четыре вида доезжают, прочее — отказ", () => {
  const mimes: readonly PictureMime[] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ];
  const whole: Collected = {
    stdout: "",
    stderr: "",
    exit: 0,
    pictures: [{ mime: "image/jpeg", data: "/9j/4AAQSkZJRg==" }],
  };
  beforeAll(() => {
    expect(collectedOf(JSON.stringify(whole))).toStrictEqual(whole);
  });
  for (const mime of mimes) {
    const picture = { mime, data: "AAAA" };
    it(mime, () => {
      expect(serverFrameOf(JSON.stringify({ picture }))).toStrictEqual({
        picture,
      });
    });
  }
  for (
    const bad of [
      '{"picture":"x"}',
      '{"picture":{"mime":"image/svg+xml","data":"AAAA"}}',
      '{"picture":{"mime":"image/jpeg","data":1}}',
      '{"picture":{"mime":"image/jpeg"}}',
    ]
  ) {
    it(bad, () => {
      expect(() => serverFrameOf(bad)).toThrow(BadFrame);
    });
  }
  for (
    const bad of [
      '{"stdout":"","stderr":"","exit":0,"pictures":{}}',
      '{"stdout":"","stderr":"","exit":0,"pictures":[{"mime":"image/bmp","data":""}]}',
    ]
  ) {
    it(bad, () => {
      expect(() => collectedOf(bad)).toThrow(BadFrame);
    });
  }
});
