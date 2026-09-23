import { assertEquals, assertThrows } from "@std/assert";
import {
  BadFrame,
  type Collected,
  collectedOf,
  lineRequest,
  type ServerFrame,
  serverFrameOf,
  stdinOf,
  ticketAnswerOf,
} from "./mod.ts";

Deno.test("кадр сервера: пять видов и отказ прочему", async (t) => {
  const frames: readonly ServerFrame[] = [
    { out: "a" },
    { err: "b" },
    { ask: "c? " },
    { stdinRequest: true },
    { exit: 2 },
  ];
  for (const frame of frames) {
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
      '{"stdinRequest":false}',
      '{"stdinRequest":"yes"}',
    ]
  ) {
    await t.step(bad, () => {
      assertThrows(() => serverFrameOf(bad), BadFrame);
    });
  }
});

Deno.test("кадр ввода клиента: строка stdin, прочее — не ввод", () => {
  assertEquals(stdinOf('{"stdin":"x"}'), "x");
  assertEquals(stdinOf('{"stdin":""}'), "");
  for (const other of ['{"stdin":1}', '{"answer":"y"}', "{", "[]", 7]) {
    assertEquals(stdinOf(other), undefined);
  }
});

Deno.test("кадр отказа: объект доезжает, поле не своего вида — отказ", async (t) => {
  const refusal = {
    reason: "не понимает",
    hint: ["kiten"],
    candidates: ["kiten"],
    text: "mpu: не понимает kitn; ближайшие: kiten",
  };
  assertEquals(serverFrameOf(JSON.stringify({ refusal })), { refusal });
  const bare = { ...refusal, hint: null, candidates: [] };
  assertEquals(serverFrameOf(JSON.stringify({ refusal: bare })), {
    refusal: bare,
  });
  assertEquals(
    collectedOf(JSON.stringify({ stdout: "", stderr: "x", exit: 2, refusal })),
    { stdout: "", stderr: "x", exit: 2, refusal },
  );
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
    await t.step(bad, () => {
      assertThrows(() => serverFrameOf(bad), BadFrame);
    });
  }
});

Deno.test("вид вопроса: secret доезжает, line опускается, чужое — отказ", async (t) => {
  const kept: ServerFrame = { ask: "Пароль: ", kind: "secret" };
  assertEquals(serverFrameOf(JSON.stringify(kept)), kept);
  // `line` — умолчание: в разобранном кадре поля нет, и прежний кадр
  // без вида от него не отличается.
  assertEquals(serverFrameOf('{"ask":"q? ","kind":"line"}'), { ask: "q? " });
  for (
    const bad of [
      '{"ask":"q? ","kind":"Secret"}',
      '{"ask":"q? ","kind":"menu"}',
      '{"ask":"q? ","kind":1}',
    ]
  ) {
    // Чужой вид — плохой кадр, а не молчаливое «видимый»: скрытое не
    // должно становиться видимым по ошибке.
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

Deno.test("собранный ответ: итог кодом или вопросом, прочее — отказ", async (t) => {
  const exited = { stdout: "a", stderr: "b", exit: 0 };
  const asked = { stdout: "", stderr: "", ask: "q? ", ticket: "ab" };
  assertEquals(collectedOf(JSON.stringify(exited)), exited);
  assertEquals(collectedOf(JSON.stringify(asked)), asked);
  // Вид вопроса доезжает и собранным ответом: иначе скрытый ответ
  // читался бы с эхом (`platform/line-prompt.md`).
  const secret: Collected = { ...asked, kind: "secret" };
  assertEquals(collectedOf(JSON.stringify(secret)), secret);
  assertEquals(collectedOf(JSON.stringify({ ...asked, kind: "line" })), asked);
  for (
    const bad of [
      "{",
      "[]",
      '{"stdout":"a"}',
      '{"stdout":"","stderr":""}',
      '{"stdout":"","stderr":"","ask":"q? ","kind":"menu","ticket":"ab"}',
    ]
  ) {
    await t.step(bad, () => {
      assertThrows(() => collectedOf(bad), BadFrame);
    });
  }
});

Deno.test("собранный ответ: вывод файлом вместо stdout", async (t) => {
  const file = {
    path: "/tmp/mpu-out/r.txt",
    bytes: 70000,
    lines: 9,
    slice: true,
  };
  assertEquals(
    collectedOf(JSON.stringify({ file, stderr: "", exit: 0 })),
    { stdout: "", stderr: "", exit: 0, file },
  );
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
    await t.step(bad, () => {
      assertThrows(() => collectedOf(bad), BadFrame);
    });
  }
});

Deno.test("первый кадр: caller — строка или нет поля", () => {
  const base = { words: ["it"], cwd: "/" };
  assertEquals(lineRequest(JSON.stringify(base)).caller, undefined);
  assertEquals(
    lineRequest(JSON.stringify({ ...base, caller: "ppid:7" })).caller,
    "ppid:7",
  );
  const err = assertThrows(
    () => lineRequest(JSON.stringify({ ...base, caller: 7 })),
    BadFrame,
  );
  assertEquals(err.message, "caller — не строка");
});
