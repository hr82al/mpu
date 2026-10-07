/**
 * Программа из stdin (`platform/program-input.md`, порция 170a): строка без
 * слов с вводом из пайпа — программа, пустой ввод — справка, ввод строки у
 * такой программы занят, отказ называет источник `stdin` без подсказки.
 * Стенд — `ask-composite.md`: `kiten ls` allow, `kiten comment` ask,
 * `sql` deny.
 */

import { assert, beforeAll, describe, expect, it } from "vitest";
import type { CommandIo } from "../command/mod.ts";
import { ASK, DENY, Human, RuleBook, RulePath } from "../policy/mod.ts";
import type { ChannelOf } from "./mod.ts";
import { within } from "../backend/testback.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import { type Ran, runOnStand, type Stand, withStand } from "./testprogram.ts";

const BOM = [0xef, 0xbb, 0xbf];

const bytes = (text: string) => new TextEncoder().encode(text);

/** Как строку зовут на стенде: ввод из пайпа, ответы человека. */
interface Piped {
  /** Ввод байтами; нет — stdin терминал. */
  readonly stdin?: Uint8Array;
  /** Ответы человека у терминала по очереди. */
  readonly answers?: readonly string[];
  /** Чтение ввода, которое не кончается (канал без писателя). */
  readonly endless?: boolean;
  /** stdin — терминал, как у голого вызова из терминала. */
  readonly terminal?: boolean;
}

/** Итог строки и сколько раз она читала ввод. */
interface PipedRan extends Ran {
  readonly reads: number;
  readonly posted: readonly string[];
}

/** Человек у терминала: вопрос — в stderr строки, ответы — по очереди. */
function humanAt(answers: readonly string[]): ChannelOf {
  const queue = [...answers];
  return (_io, output) =>
    new Human(output.stderr, () => Promise.resolve(queue.shift()));
}

/** Ввод строки на стенде: пайп с байтами, пайп без писателя или терминал. */
function inputOf(given: Piped, read: () => void): Partial<CommandIo> {
  if (given.endless) {
    return {
      stdinIsTerminal: () => false,
      readStdin: () => {
        read();
        return new Promise(() => {});
      },
    };
  }
  const stdin = given.stdin;
  if (stdin === undefined || given.terminal) {
    return {
      readStdin: () => {
        read();
        return Promise.resolve(new Uint8Array());
      },
    };
  }
  return {
    stdinIsTerminal: () => false,
    readStdin: () => {
      read();
      return Promise.resolve(stdin.slice());
    },
  };
}

/** Строка `words` на стенде с правилами таблицы спеки. */
function run(words: readonly string[], given: Piped = {}): Promise<PipedRan> {
  let result: PipedRan | undefined;
  return withPolicyFile((file) =>
    withStand(async (stand: Stand) => {
      allowEverything(file);
      {
        using book = RuleBook.open(file, []);
        book.set(RulePath.parse("kiten comment"), ASK);
        book.set(RulePath.parse("sql"), DENY);
      }
      let reads = 0;
      const ran = await runOnStand(file, words, stand, {
        io: { ...inputOf(given, () => reads++), stderrIsTerminal: () => true },
        channel: humanAt(given.answers ?? []),
      });
      result = { ...ran, reads, posted: stand.posted() };
    }),
  ).then(() => {
    if (result === undefined) throw new Error("стенд не прогнал строку");
    return result;
  });
}

it("stdin: ввод — программа целиком", async () => {
  const got = await run([], { stdin: bytes("2 plus: 1 . 2 plus: 2") });
  expect([got.stdout, got.stderr, got.exit]).toStrictEqual(["4\n", "", 0]);
  expect(got.reads).toBe(1);
});

describe("stdin: пустой ввод — справка, как прежде", () => {
  // Эталоны снимаются прогоном до шагов; случаи ссылаются на них по ключу.
  const expected: { root?: Ran; door?: Ran } = {};
  beforeAll(async () => {
    expected.root = await run(["help"]);
    // Голый `mpu ask` — справка двери с кодом 2, как прежде (решение хоста).
    expected.door = await run(["ask"], {
      stdin: new Uint8Array(),
      terminal: true,
    });
  });
  const cases: readonly (readonly [
    string,
    readonly string[],
    Piped,
    keyof typeof expected,
  ])[] = [
    ["mpu </dev/null", [], { stdin: new Uint8Array() }, "root"],
    [
      "BOM и разделители",
      [],
      { stdin: new Uint8Array([...BOM, ...bytes(" \r\n\t")]) },
      "root",
    ],
    ["mpu ask </dev/null", ["ask"], { stdin: new Uint8Array() }, "door"],
    ["mpu в терминале", [], {}, "root"],
  ];
  for (const [name, words, given, which] of cases) {
    it(name, async () => {
      const want = expected[which];
      assert(want !== undefined, "эталон не снят");
      const got = await run(words, given);
      expect(got.exit, got.stderr).toStrictEqual(want.exit);
      expect(got.stderr).toStrictEqual(want.stderr);
      expect(got.stdout).toStrictEqual(want.stdout);
    });
  }
  it("справка двери — та же, что mpu ask help", async () => {
    assert(expected.door !== undefined, "эталон не снят");
    expect(expected.door.stdout).toStrictEqual(
      (await run(["ask", "help"])).stdout,
    );
  });
  it("терминал ввод не читает", async () => {
    expect((await run([])).reads).toBe(0);
  });
});

it("stdin: строка со словами ввода не ждёт", async () => {
  // Сторож: строка, ждущая ввода, краснеет сообщением, а не висит.
  const got = await within(
    run(["version"], { endless: true }),
    5_000,
    "строка со словами ждёт ввода",
  );
  expect(got.exit, got.stderr).toBe(0);
  expect(got.reads).toBe(0);
});

it("stdin: BOM и \\r\\n до разбора не доходят", async () => {
  const got = await run([], {
    stdin: new Uint8Array([...BOM, ...bytes("^готово к ревью^ print\r\n")]),
  });
  expect([got.stdout, got.stderr, got.exit]).toStrictEqual([
    "готово к ревью\n",
    "",
    0,
  ]);
});

it("stdin: длинная программа — 17 100 выражений", async () => {
  const got = await run([], { stdin: bytes("1 plus: 1 . ".repeat(17_100)) });
  expect([got.stdout, got.stderr, got.exit]).toStrictEqual(["2\n", "", 0]);
});

it("stdin: отказ разбора — префикс stdin, подсказки нет", async () => {
  const got = await run([], { stdin: bytes("kitn ls") });
  expect(got.exit).toBe(2);
  expect(got.stderr).toBe(
    "stdin: выражение 1: mpu: не понимает kitn; ближайшие: kiten\n",
  );
  expect(got.refusals).toStrictEqual([
    {
      reason: "не понимает",
      hint: null,
      candidates: ["kiten"],
      text: "stdin: выражение 1: mpu: не понимает kitn; ближайшие: kiten",
    },
  ]);
});

it("stdin: отказ вычисления — префикс stdin, подсказки нет", async () => {
  const got = await run([], { stdin: bytes("2 plux: 2") });
  expect(got.exit, got.stderr).toBe(1);
  expect(got.refusals.map((one) => one.hint)).toStrictEqual([null]);
  expect(got.stderr.startsWith("stdin: выражение 1: "), got.stderr).toBe(true);
  expect(got.stderr.includes(" — mpu "), got.stderr).toBe(false);
});

it("stdin: параметров нет — @x не связана", async () => {
  const got = await run([], { stdin: bytes("@col print") });
  expect(got.exit).toBe(2);
  expect(got.stderr).toBe(
    "stdin: выражение 1: col не связана; связанных нет\n",
  );
});

it("stdin: ввод занят программой — отказ значения, записи нет", async () => {
  const got = await run(["ask"], {
    stdin: bytes("2 print . kiten comment id: 11 text: stdin"),
    answers: ["y"],
  });
  expect(got.stdout).toBe("2\n");
  expect(got.stderr).toStrictEqual(
    "mpu ask kiten comment: ввод занят программой — программу передай " +
      "файлом: mpu run: <файл.mpu>\n",
  );
  expect(got.exit).toBe(2);
  expect(got.posted).toStrictEqual([]);
  expect(got.refusals.map((one) => one.reason)).toStrictEqual([
    "ввод занят программой",
  ]);
});

it("stdin: -- stdin — слово, ввод не читается", async () => {
  const got = await run(["ask"], {
    stdin: bytes("kiten comment id: 11 text: -- stdin"),
    answers: ["y"],
  });
  expect(got.stderr).toBe(
    "выполнить mpu kiten comment id: 11 text: stdin? [y/N] ",
  );
  expect(got.exit).toBe(0);
  expect(got.posted).toStrictEqual(["11 stdin"]);
});

it("stdin: запись без двери — отказ всей строки с подсказкой ask", async () => {
  const got = await run([], { stdin: bytes("kiten comment id: 5 text: a") });
  expect(got.stderr).toBe(
    "stdin: строка может записать (kiten comment) — начни с ask: mpu ask\n",
  );
  expect(got.refusals.map((one) => one.hint)).toStrictEqual([["ask"]]);
  expect(got.exit).toBe(2);
  expect(got.posted).toStrictEqual([]);
});

it("stdin: запись через дверь — вопрос человеку", async () => {
  const got = await run(["ask"], {
    stdin: bytes("kiten comment id: 11 text: a"),
    answers: ["y"],
  });
  expect(got.stderr).toBe("выполнить mpu kiten comment id: 11 text: a? [y/N] ");
  expect(got.exit).toBe(0);
  expect(got.posted).toStrictEqual(["11 a"]);
});

it("stdin: запись журнала — как набрано, без текста программы", async () => {
  const got = await run([], { stdin: bytes("2 plus: 2") });
  expect(got.exit, got.stderr).toBe(0);
  expect(got.native).toStrictEqual([""]);
});
