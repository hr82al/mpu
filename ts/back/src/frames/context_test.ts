import { assertEquals, assertThrows } from "@std/assert";
import {
  BadFrame,
  callContextOf,
  CLIENT_ENV_NAMES,
  contextFieldsOf,
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

Deno.test("ввод: поля нет — пусто, есть — то же содержимое дважды", () => {
  const absent = callContextOf({});
  assertEquals(absent.input.bytes(), new Uint8Array());
  const given = callContextOf({ stdin: "текст\n" });
  assertEquals(decoder.decode(given.input.bytes()), "текст\n");
  assertEquals(decoder.decode(given.input.bytes()), "текст\n");
});

Deno.test("ввод: пустая строка — это ввод, испортить чужой буфер нельзя", () => {
  assertEquals(callContextOf({ stdin: "" }).input.bytes(), new Uint8Array());
  const context = callContextOf({ stdin: "аб" });
  const first = context.input.bytes();
  first[0] = 0;
  assertEquals(decoder.decode(context.input.bytes()), "аб");
});

Deno.test("ввод: предел меряется байтами, а не длиной строки", async (t) => {
  await t.step("ровно предел — принимается", () => {
    const text = "a".repeat(MAX_STDIN_BYTES);
    assertEquals(
      callContextOf({ stdin: text }).input.bytes().length,
      MAX_STDIN_BYTES,
    );
  });
  await t.step("предел + байт — отказ", () => {
    const text = "a".repeat(MAX_STDIN_BYTES + 1);
    const err = assertThrows(() => callContextOf({ stdin: text }), BadFrame);
    assertEquals(err.report, "ввод больше 8 МиБ");
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
  ];
  for (const body of refused) {
    await t.step(body, () => {
      const err = assertThrows(() => ticketAnswerOf(body), BadFrame);
      assertEquals(err.report, "контекст вызова в ответе не принимается");
    });
  }
});

Deno.test("клиент снимает контекст: пайп, терминал, предел", async (t) => {
  const facts = {
    stdin: () => Promise.resolve("текст\n" as string | undefined),
    stdinIsTerminal: () => false,
    stdoutIsTerminal: () => true,
    stderrIsTerminal: () => true,
    columns: () => 120 as number | undefined,
    value: (name: string) => (name === "NO_COLOR" ? "1" : undefined),
  };
  await t.step("из пайпа: ввод, терминальность, имена списка", async () => {
    assertEquals(await contextFieldsOf(facts), {
      stdin: "текст\n",
      tty: { stdin: false, stdout: true, stderr: true, columns: 120 },
      env: { NO_COLOR: "1" },
    });
  });
  await t.step("stdin — терминал: поля нет", async () => {
    const fields = await contextFieldsOf({
      ...facts,
      stdin: () => Promise.resolve(undefined),
      stdinIsTerminal: () => true,
    });
    assertEquals("stdin" in fields, false);
    assertEquals(fields.tty?.stdin, true);
  });
  await t.step("stdout не терминал: ширины нет", async () => {
    const fields = await contextFieldsOf({
      ...facts,
      stdoutIsTerminal: () => false,
      columns: () => undefined,
    });
    assertEquals(fields.tty, { stdin: false, stdout: false, stderr: true });
  });
  await t.step("нет ни одного имени списка: поля env нет", async () => {
    const fields = await contextFieldsOf({ ...facts, value: () => undefined });
    assertEquals("env" in fields, false);
  });
  await t.step("ввод больше предела: тот же отказ, что у сервера", async () => {
    const big = "a".repeat(MAX_STDIN_BYTES + 1);
    const err = await contextFieldsOf({
      ...facts,
      stdin: () => Promise.resolve(big),
    }).then(() => undefined, (err: unknown) => err);
    assertEquals(err instanceof BadFrame, true);
    assertEquals((err as BadFrame).report, tooLargeInput());
  });
});

Deno.test("список имён — только про вид вывода", () => {
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
  assertEquals(NO_INPUT.bytes(), new Uint8Array());
});
