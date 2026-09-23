import { assertEquals, assertThrows } from "@std/assert";
import {
  BadFrame,
  boundedInput,
  callContextOf,
  CLIENT_ENV_NAMES,
  contextFieldsOf,
  FRAME_INPUT,
  inputOnRequest,
  MAX_COLUMNS,
  MAX_STDIN_BYTES,
  MIN_COLUMNS,
  NO_INPUT,
  NOT_TERMINALS,
  SERVER_RULE,
  ticketAnswerOf,
  tooLargeInput,
} from "./mod.ts";

const decoder = new TextDecoder();

/** Окружение сервера в тестах: одно имя со значением, прочих нет. */
const serverEnv = (name: string) => name === "COLUMNS" ? "сервер" : undefined;

Deno.test("ввод: поля нет — пусто, есть — то же содержимое дважды", async () => {
  const absent = callContextOf({});
  assertEquals(await absent.input.bytes(), new Uint8Array());
  const given = callContextOf({ stdin: "текст\n" });
  assertEquals(decoder.decode(await given.input.bytes()), "текст\n");
  assertEquals(decoder.decode(await given.input.bytes()), "текст\n");
});

Deno.test("ввод: пустая строка — это ввод, испортить чужой буфер нельзя", async () => {
  assertEquals(
    await callContextOf({ stdin: "" }).input.bytes(),
    new Uint8Array(),
  );
  const context = callContextOf({ stdin: "аб" });
  const first = await context.input.bytes();
  first[0] = 0;
  assertEquals(decoder.decode(await context.input.bytes()), "аб");
});

Deno.test("ввод по запросу: ввод строки — объект транспорта", async (t) => {
  const requested = { bytes: () => Promise.resolve(new Uint8Array([1])) };
  const socket = inputOnRequest(requested);
  await t.step("stdinOnRequest: true — ввод транспорта", () => {
    const context = callContextOf({ stdinOnRequest: true }, socket);
    assertEquals(context.input, requested);
  });
  await t.step("false — как поля нет, stdin — из кадра", async () => {
    const context = callContextOf({ stdinOnRequest: false }, socket);
    assertEquals(await context.input.bytes(), new Uint8Array());
    const given = callContextOf({ stdinOnRequest: false, stdin: "x" }, socket);
    assertEquals(decoder.decode(await given.input.bytes()), "x");
  });
  await t.step("простой HTTP: поле не читается любым значением", async () => {
    for (const value of [true, "yes"]) {
      const context = callContextOf({ stdinOnRequest: value }, FRAME_INPUT);
      assertEquals(await context.input.bytes(), new Uint8Array());
    }
    const given = callContextOf({ stdinOnRequest: true, stdin: "x" });
    assertEquals(decoder.decode(await given.input.bytes()), "x");
  });
  const bad: readonly Record<string, unknown>[] = [
    { stdinOnRequest: true, stdin: "x" },
    { stdinOnRequest: true, stdin: "" },
    { stdinOnRequest: "yes" },
    { stdinOnRequest: 1 },
  ];
  for (const frame of bad) {
    await t.step(JSON.stringify(frame), () => {
      const err = assertThrows(() => callContextOf(frame, socket), BadFrame);
      assertEquals(err.report, "плохой кадр строки");
    });
  }
});

Deno.test("ввод: предел меряется байтами, а не длиной строки", async (t) => {
  await t.step("ровно предел — принимается", async () => {
    const text = "a".repeat(MAX_STDIN_BYTES);
    assertEquals(
      (await callContextOf({ stdin: text }).input.bytes()).length,
      MAX_STDIN_BYTES,
    );
    assertEquals(boundedInput(text).length, MAX_STDIN_BYTES);
  });
  await t.step("предел + байт — отказ", () => {
    const text = "a".repeat(MAX_STDIN_BYTES + 1);
    const err = assertThrows(() => callContextOf({ stdin: text }), BadFrame);
    assertEquals(err.report, "ввод больше 8 МиБ");
    assertThrows(() => boundedInput(text), BadFrame, "ввод больше предела");
  });
  await t.step("двухбайтные символы: длина под пределом, байты над", () => {
    const text = "я".repeat(MAX_STDIN_BYTES / 2 + 1);
    assertEquals(text.length < MAX_STDIN_BYTES, true);
    const err = assertThrows(() => callContextOf({ stdin: text }), BadFrame);
    assertEquals(err.report, tooLargeInput());
  });
});

Deno.test("терминальность: поля нет — не терминалы и ширины нет", () => {
  const context = callContextOf({});
  assertEquals(context.terminals, NOT_TERMINALS);
  assertEquals(
    [
      NOT_TERMINALS.stdin(),
      NOT_TERMINALS.stdout(),
      NOT_TERMINALS.stderr(),
      NOT_TERMINALS.columns(),
    ],
    [false, false, false, undefined],
  );
});

Deno.test("терминальность: поля кадра, ширина только при терминале", async (t) => {
  const context = callContextOf({
    tty: { stdin: false, stdout: true, stderr: true, columns: 120 },
  });
  assertEquals(
    [
      context.terminals.stdin(),
      context.terminals.stdout(),
      context.terminals.stderr(),
      context.terminals.columns(),
    ],
    [false, true, true, 120],
  );
  await t.step("без columns — ширины нет", () => {
    const narrow = callContextOf({ tty: { stdout: true } });
    assertEquals(narrow.terminals.columns(), undefined);
    assertEquals(narrow.terminals.stdout(), true);
  });
  await t.step("columns без терминала — свой отказ", () => {
    const err = assertThrows(
      () => callContextOf({ tty: { stdout: false, columns: 120 } }),
      BadFrame,
    );
    assertEquals(err.report, "ширина без терминала");
  });
});

Deno.test("окружение: поля нет или пусто — правило сервера", () => {
  assertEquals(callContextOf({}).env, SERVER_RULE);
  assertEquals(callContextOf({ env: {} }).env, SERVER_RULE);
  assertEquals(SERVER_RULE.over(serverEnv).value("COLUMNS"), "сервер");
});

Deno.test("окружение: имя клиента перекрывает, прочие — от сервера", () => {
  const context = callContextOf({ env: { COLUMNS: "120", NO_COLOR: "" } });
  const env = context.env.over(serverEnv);
  assertEquals(env.value("COLUMNS"), "120");
  assertEquals(env.value("NO_COLOR"), "");
  assertEquals(env.value("HOME"), undefined);
  assertEquals(SERVER_RULE.over(serverEnv).value("COLUMNS"), "сервер");
});

Deno.test("окружение: имя вне списка — отказ с именами в порядке прихода", async (t) => {
  const cases: readonly (readonly [Record<string, string>, string])[] = [
    [{ HOME: "/дом" }, "переменная вне списка: HOME"],
    [{ PGHOST: "боевой" }, "переменная вне списка: PGHOST"],
    [{ PGPASSWORD: "s3cret" }, "переменная вне списка: PGPASSWORD"],
    [{ _MPU_COMPLETE: "bash" }, "переменная вне списка: _MPU_COMPLETE"],
    [
      { NO_COLOR: "1", PGHOST: "боевой", HOME: "/дом" },
      "переменная вне списка: PGHOST, HOME",
    ],
  ];
  for (const [env, report] of cases) {
    await t.step(report, () => {
      const err = assertThrows(() => callContextOf({ env }), BadFrame);
      assertEquals(err.report, report);
      assertEquals(err.report.includes("боевой"), false);
      assertEquals(err.report.includes("s3cret"), false);
    });
  }
});

Deno.test("плохой кадр: вид полей", async (t) => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["stdin не строка", { stdin: 1 }],
    ["tty не объект", { tty: "да" }],
    ["tty список", { tty: [] }],
    ["флаг не булев", { tty: { stdout: "да" } }],
    ["columns не целое", { tty: { stdout: true, columns: 1.5 } }],
    ["columns ноль", { tty: { stdout: true, columns: MIN_COLUMNS - 1 } }],
    ["columns больше предела", {
      tty: { stdout: true, columns: MAX_COLUMNS + 1 },
    }],
    ["env не объект", { env: "COLUMNS=120" }],
    ["env значение не строка", { env: { COLUMNS: 120 } }],
  ];
  for (const [name, frame] of cases) {
    await t.step(name, () => {
      const err = assertThrows(() => callContextOf(frame), BadFrame);
      assertEquals(err.report, "плохой кадр строки");
    });
  }
});

Deno.test("контекст в теле ответа по номеру — отказ по любому из трёх полей", async (t) => {
  const accepted: readonly string[] = [
    '{"ticket":"ab","answer":"y"}',
    "[]",
    "{",
  ];
  for (const body of accepted) {
    await t.step(body, () => {
      assertEquals(typeof ticketAnswerOf(body).ticket, "string");
    });
  }
  const refused: readonly string[] = [
    '{"ticket":"ab","answer":"y","stdin":"текст"}',
    '{"ticket":"ab","tty":{"stdout":true}}',
    '{"ticket":"ab","env":{}}',
    '{"ticket":"ab","stdinOnRequest":true}',
  ];
  for (const body of refused) {
    await t.step(body, () => {
      const err = assertThrows(() => ticketAnswerOf(body), BadFrame);
      assertEquals(err.report, "контекст вызова в ответе не принимается");
    });
  }
});

Deno.test("клиент снимает контекст: пайп, терминал; stdin не читает", async (t) => {
  const facts = {
    // Снятие контекста stdin не трогает: чтение тут — дефект.
    stdin: (): Promise<string> => {
      throw new Error("stdin читался при снятии контекста");
    },
    stdinIsTerminal: () => false,
    stdoutIsTerminal: () => true,
    stderrIsTerminal: () => true,
    columns: () => 120 as number | undefined,
    value: (name: string) => (name === "NO_COLOR" ? "1" : undefined),
  };
  await t.step("из пайпа: ввод по запросу, терминальность, имена", () => {
    assertEquals(contextFieldsOf(facts), {
      stdinOnRequest: true,
      tty: { stdin: false, stdout: true, stderr: true, columns: 120 },
      env: { NO_COLOR: "1" },
    });
  });
  await t.step("stdin — терминал: полей ввода нет", () => {
    const fields = contextFieldsOf({ ...facts, stdinIsTerminal: () => true });
    assertEquals("stdin" in fields, false);
    assertEquals("stdinOnRequest" in fields, false);
    assertEquals(fields.tty?.stdin, true);
  });
  await t.step("stdout не терминал: ширины нет", () => {
    const fields = contextFieldsOf({
      ...facts,
      stdoutIsTerminal: () => false,
      columns: () => undefined,
    });
    assertEquals(fields.tty, { stdin: false, stdout: false, stderr: true });
  });
  await t.step("нет ни одного имени списка: поля env нет", () => {
    const fields = contextFieldsOf({ ...facts, value: () => undefined });
    assertEquals("env" in fields, false);
  });
});

Deno.test("список имён — только про вид вывода", async () => {
  assertEquals([...CLIENT_ENV_NAMES], [
    "COLUMNS",
    "NO_COLOR",
    "TERM",
    "TERM_PROGRAM",
    "COLORTERM",
    "TMUX",
    "WT_SESSION",
    "OS",
  ]);
  for (const name of ["HOME", "XDG_CONFIG_HOME", "PGHOST", "PGPASSWORD"]) {
    assertEquals(CLIENT_ENV_NAMES.includes(name), false);
  }
  assertEquals(await NO_INPUT.bytes(), new Uint8Array());
});
