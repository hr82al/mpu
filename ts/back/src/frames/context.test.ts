import { beforeAll, describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
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
const serverEnv = (name: string) => (name === "COLUMNS" ? "сервер" : undefined);

it("ввод: поля нет — пусто, есть — то же содержимое дважды", async () => {
  const absent = callContextOf({});
  expect(await absent.input.bytes()).toStrictEqual(new Uint8Array());
  const given = callContextOf({ stdin: "текст\n" });
  expect(decoder.decode(await given.input.bytes())).toBe("текст\n");
  expect(decoder.decode(await given.input.bytes())).toBe("текст\n");
});

it("ввод: пустая строка — это ввод, испортить чужой буфер нельзя", async () => {
  expect(await callContextOf({ stdin: "" }).input.bytes()).toStrictEqual(
    new Uint8Array(),
  );
  const context = callContextOf({ stdin: "аб" });
  const first = await context.input.bytes();
  first[0] = 0;
  expect(decoder.decode(await context.input.bytes())).toBe("аб");
});

describe("ввод по запросу: ввод строки — объект транспорта", () => {
  const requested = { bytes: () => Promise.resolve(new Uint8Array([1])) };
  const socket = inputOnRequest(requested);
  it("stdinOnRequest: true — ввод транспорта", () => {
    const context = callContextOf({ stdinOnRequest: true }, socket);
    expect(context.input).toStrictEqual(requested);
  });
  it("false — как поля нет, stdin — из кадра", async () => {
    const context = callContextOf({ stdinOnRequest: false }, socket);
    expect(await context.input.bytes()).toStrictEqual(new Uint8Array());
    const given = callContextOf({ stdinOnRequest: false, stdin: "x" }, socket);
    expect(decoder.decode(await given.input.bytes())).toBe("x");
  });
  it("простой HTTP: поле не читается любым значением", async () => {
    for (const value of [true, "yes"]) {
      const context = callContextOf({ stdinOnRequest: value }, FRAME_INPUT);
      expect(await context.input.bytes()).toStrictEqual(new Uint8Array());
    }
    const given = callContextOf({ stdinOnRequest: true, stdin: "x" });
    expect(decoder.decode(await given.input.bytes())).toBe("x");
  });
  const bad: readonly Record<string, unknown>[] = [
    { stdinOnRequest: true, stdin: "x" },
    { stdinOnRequest: true, stdin: "" },
    { stdinOnRequest: "yes" },
    { stdinOnRequest: 1 },
  ];
  for (const frame of bad) {
    it(JSON.stringify(frame), () => {
      const err = thrown(() => callContextOf(frame, socket), BadFrame);
      expect(err.report).toBe("плохой кадр строки");
    });
  }
});

describe("ввод: предел меряется байтами, а не длиной строки", () => {
  it("ровно предел — принимается", async () => {
    const text = "a".repeat(MAX_STDIN_BYTES);
    expect(
      (await callContextOf({ stdin: text }).input.bytes()).length,
    ).toStrictEqual(MAX_STDIN_BYTES);
    expect(boundedInput(text).length).toStrictEqual(MAX_STDIN_BYTES);
  });
  it("предел + байт — отказ", () => {
    const text = "a".repeat(MAX_STDIN_BYTES + 1);
    const err = thrown(() => callContextOf({ stdin: text }), BadFrame);
    expect(err.report).toBe("ввод больше 8 МиБ");
    thrown(() => boundedInput(text), BadFrame, "ввод больше предела");
  });
  it("двухбайтные символы: длина под пределом, байты над", () => {
    const text = "я".repeat(MAX_STDIN_BYTES / 2 + 1);
    expect(text.length < MAX_STDIN_BYTES).toBe(true);
    const err = thrown(() => callContextOf({ stdin: text }), BadFrame);
    expect(err.report).toStrictEqual(tooLargeInput());
  });
});

it("терминальность: поля нет — не терминалы и ширины нет", () => {
  const context = callContextOf({});
  expect(context.terminals).toStrictEqual(NOT_TERMINALS);
  expect([
    NOT_TERMINALS.stdin(),
    NOT_TERMINALS.stdout(),
    NOT_TERMINALS.stderr(),
    NOT_TERMINALS.columns(),
  ]).toStrictEqual([false, false, false, undefined]);
});

describe("терминальность: поля кадра, ширина только при терминале", () => {
  const context = callContextOf({
    tty: { stdin: false, stdout: true, stderr: true, columns: 120 },
  });
  beforeAll(() => {
    expect([
      context.terminals.stdin(),
      context.terminals.stdout(),
      context.terminals.stderr(),
      context.terminals.columns(),
    ]).toStrictEqual([false, true, true, 120]);
  });
  it("без columns — ширины нет", () => {
    const narrow = callContextOf({ tty: { stdout: true } });
    expect(narrow.terminals.columns()).toStrictEqual(undefined);
    expect(narrow.terminals.stdout()).toBe(true);
  });
  it("columns без терминала — свой отказ", () => {
    const err = thrown(
      () => callContextOf({ tty: { stdout: false, columns: 120 } }),
      BadFrame,
    );
    expect(err.report).toBe("ширина без терминала");
  });
});

it("окружение: поля нет или пусто — правило сервера", () => {
  expect(callContextOf({}).env).toStrictEqual(SERVER_RULE);
  expect(callContextOf({ env: {} }).env).toStrictEqual(SERVER_RULE);
  expect(SERVER_RULE.over(serverEnv).value("COLUMNS")).toBe("сервер");
});

it("окружение: имя клиента перекрывает, прочие — от сервера", () => {
  const context = callContextOf({ env: { COLUMNS: "120", NO_COLOR: "" } });
  const env = context.env.over(serverEnv);
  expect(env.value("COLUMNS")).toBe("120");
  expect(env.value("NO_COLOR")).toBe("");
  expect(env.value("HOME")).toStrictEqual(undefined);
  expect(SERVER_RULE.over(serverEnv).value("COLUMNS")).toBe("сервер");
});

describe("окружение: имя вне списка — отказ с именами в порядке прихода", () => {
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
    it(report, () => {
      const err = thrown(() => callContextOf({ env }), BadFrame);
      expect(err.report).toStrictEqual(report);
      expect(err.report.includes("боевой")).toBe(false);
      expect(err.report.includes("s3cret")).toBe(false);
    });
  }
});

describe("плохой кадр: вид полей", () => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["stdin не строка", { stdin: 1 }],
    ["tty не объект", { tty: "да" }],
    ["tty список", { tty: [] }],
    ["флаг не булев", { tty: { stdout: "да" } }],
    ["columns не целое", { tty: { stdout: true, columns: 1.5 } }],
    ["columns ноль", { tty: { stdout: true, columns: MIN_COLUMNS - 1 } }],
    [
      "columns больше предела",
      {
        tty: { stdout: true, columns: MAX_COLUMNS + 1 },
      },
    ],
    ["env не объект", { env: "COLUMNS=120" }],
    ["env значение не строка", { env: { COLUMNS: 120 } }],
  ];
  for (const [name, frame] of cases) {
    it(name, () => {
      const err = thrown(() => callContextOf(frame), BadFrame);
      expect(err.report).toBe("плохой кадр строки");
    });
  }
});

describe("контекст в теле ответа по номеру — отказ по любому из трёх полей", () => {
  const accepted: readonly string[] = [
    '{"ticket":"ab","answer":"y"}',
    "[]",
    "{",
  ];
  for (const body of accepted) {
    it(body, () => {
      expect(typeof ticketAnswerOf(body).ticket).toBe("string");
    });
  }
  const refused: readonly string[] = [
    '{"ticket":"ab","answer":"y","stdin":"текст"}',
    '{"ticket":"ab","tty":{"stdout":true}}',
    '{"ticket":"ab","env":{}}',
    '{"ticket":"ab","stdinOnRequest":true}',
  ];
  for (const body of refused) {
    it(body, () => {
      const err = thrown(() => ticketAnswerOf(body), BadFrame);
      expect(err.report).toBe("контекст вызова в ответе не принимается");
    });
  }
});

describe("клиент снимает контекст: пайп, терминал; stdin не читает", () => {
  const facts = {
    // Снятие контекста stdin не трогает: чтение тут — дефект.
    stdin: (): Promise<Uint8Array> => {
      throw new Error("stdin читался при снятии контекста");
    },
    stdinIsTerminal: () => false,
    stdoutIsTerminal: () => true,
    stderrIsTerminal: () => true,
    columns: () => 120 as number | undefined,
    value: (name: string) => (name === "NO_COLOR" ? "1" : undefined),
  };
  it("из пайпа: ввод по запросу, терминальность, имена", () => {
    expect(contextFieldsOf(facts)).toStrictEqual({
      stdinOnRequest: true,
      tty: { stdin: false, stdout: true, stderr: true, columns: 120 },
      env: { NO_COLOR: "1" },
    });
  });
  it("stdin — терминал: полей ввода нет", () => {
    const fields = contextFieldsOf({ ...facts, stdinIsTerminal: () => true });
    expect("stdin" in fields).toBe(false);
    expect("stdinOnRequest" in fields).toBe(false);
    expect(fields.tty?.stdin).toBe(true);
  });
  it("stdout не терминал: ширины нет", () => {
    const fields = contextFieldsOf({
      ...facts,
      stdoutIsTerminal: () => false,
      columns: () => undefined,
    });
    expect(fields.tty).toStrictEqual({
      stdin: false,
      stdout: false,
      stderr: true,
    });
  });
  it("нет ни одного имени списка: поля env нет", () => {
    const fields = contextFieldsOf({ ...facts, value: () => undefined });
    expect("env" in fields).toBe(false);
  });
});

it("список имён — только про вид вывода", async () => {
  expect([...CLIENT_ENV_NAMES]).toStrictEqual([
    "COLUMNS",
    "NO_COLOR",
    "TERM",
    "TERM_PROGRAM",
    "COLORTERM",
    "TMUX",
    "TMUX_PANE",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "WT_SESSION",
    "OS",
  ]);
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "PGHOST",
    "PGPASSWORD",
    "CLAUDE_CODE_MESSAGING_TOKEN",
  ]) {
    expect(CLIENT_ENV_NAMES.includes(name)).toBe(false);
  }
  expect(await NO_INPUT.bytes()).toStrictEqual(new Uint8Array());
});
