/**
 * Строка без слов и ввод (`platform/stage6-l1.md`): пустой ввод или
 * терминал — справка, как прежде; строка со словами ввода не ждёт.
 * Стенд — `ask-composite.md`: `kiten ls` allow, `kiten comment` ask,
 * `sql` deny.
 */

import { assert, beforeAll, describe, expect, it } from "vitest";
import type { CommandIo } from "@mpu/command";
import { ASK, DENY, Human, RuleBook, RulePath } from "@mpu/command/policy";
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
