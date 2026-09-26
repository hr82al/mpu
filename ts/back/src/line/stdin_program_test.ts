/**
 * Программа из stdin (`platform/program-input.md`, порция 170a): строка без
 * слов с вводом из пайпа — программа, пустой ввод — справка, ввод строки у
 * такой программы занят, отказ называет источник `stdin` без подсказки.
 * Стенд — `ask-composite.md`: `kiten ls` allow, `kiten comment` ask,
 * `sql` deny.
 */

import { assertEquals } from "@std/assert";
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
    })
  ).then(() => {
    if (result === undefined) throw new Error("стенд не прогнал строку");
    return result;
  });
}

Deno.test("stdin: ввод — программа целиком", async () => {
  const got = await run([], { stdin: bytes("2 plus: 1 . 2 plus: 2") });
  assertEquals([got.stdout, got.stderr, got.exit], ["4\n", "", 0]);
  assertEquals(got.reads, 1);
});

Deno.test("stdin: пустой ввод — справка, как прежде", async (t) => {
  const root = await run(["help"]);
  // Голый `mpu ask` — справка двери с кодом 2, как прежде (решение хоста).
  const door = await run(["ask"], { stdin: new Uint8Array(), terminal: true });
  const cases: readonly (readonly [string, readonly string[], Piped, Ran])[] = [
    ["mpu </dev/null", [], { stdin: new Uint8Array() }, root],
    [
      "BOM и разделители",
      [],
      { stdin: new Uint8Array([...BOM, ...bytes(" \r\n\t")]) },
      root,
    ],
    ["mpu ask </dev/null", ["ask"], { stdin: new Uint8Array() }, door],
    ["mpu в терминале", [], {}, root],
  ];
  for (const [name, words, given, expected] of cases) {
    await t.step(name, async () => {
      const got = await run(words, given);
      assertEquals(got.exit, expected.exit, got.stderr);
      assertEquals(got.stderr, expected.stderr);
      assertEquals(got.stdout, expected.stdout);
    });
  }
  await t.step("справка двери — та же, что mpu ask help", async () => {
    assertEquals(door.stdout, (await run(["ask", "help"])).stdout);
  });
  await t.step("терминал ввод не читает", async () => {
    assertEquals((await run([])).reads, 0);
  });
});

Deno.test("stdin: строка со словами ввода не ждёт", async () => {
  // Сторож: строка, ждущая ввода, краснеет сообщением, а не висит.
  const got = await within(
    run(["version"], { endless: true }),
    5_000,
    "строка со словами ждёт ввода",
  );
  assertEquals(got.exit, 0, got.stderr);
  assertEquals(got.reads, 0);
});

Deno.test("stdin: BOM и \\r\\n до разбора не доходят", async () => {
  const got = await run([], {
    stdin: new Uint8Array([...BOM, ...bytes("^готово к ревью^ print\r\n")]),
  });
  assertEquals([got.stdout, got.stderr, got.exit], ["готово к ревью\n", "", 0]);
});

Deno.test("stdin: длинная программа — 17 100 выражений", async () => {
  const got = await run([], { stdin: bytes("1 plus: 1 . ".repeat(17_100)) });
  assertEquals([got.stdout, got.stderr, got.exit], ["2\n", "", 0]);
});

Deno.test("stdin: отказ разбора — префикс stdin, подсказки нет", async () => {
  const got = await run([], { stdin: bytes("kitn ls") });
  assertEquals(got.exit, 2);
  assertEquals(
    got.stderr,
    "stdin: выражение 1: mpu: не понимает kitn; ближайшие: kiten\n",
  );
  assertEquals(got.refusals, [{
    reason: "не понимает",
    hint: null,
    candidates: ["kiten"],
    text: "stdin: выражение 1: mpu: не понимает kitn; ближайшие: kiten",
  }]);
});

Deno.test("stdin: отказ вычисления — префикс stdin, подсказки нет", async () => {
  const got = await run([], { stdin: bytes("2 plux: 2") });
  assertEquals(got.exit, 1, got.stderr);
  assertEquals(got.refusals.map((one) => one.hint), [null]);
  assertEquals(got.stderr.startsWith("stdin: выражение 1: "), true, got.stderr);
  assertEquals(got.stderr.includes(" — mpu "), false, got.stderr);
});

Deno.test("stdin: параметров нет — @x не связана", async () => {
  const got = await run([], { stdin: bytes("@col print") });
  assertEquals(got.exit, 2);
  assertEquals(
    got.stderr,
    "stdin: выражение 1: col не связана; связанных нет\n",
  );
});

Deno.test("stdin: ввод занят программой — отказ значения, записи нет", async () => {
  const got = await run(["ask"], {
    stdin: bytes("2 print . kiten comment id: 11 text: stdin"),
    answers: ["y"],
  });
  assertEquals(got.stdout, "2\n");
  assertEquals(
    got.stderr,
    "mpu ask kiten comment: ввод занят программой — программу передай " +
      "файлом: mpu run: <файл.mpu>\n",
  );
  assertEquals(got.exit, 2);
  assertEquals(got.posted, []);
  assertEquals(got.refusals.map((one) => one.reason), [
    "ввод занят программой",
  ]);
});

Deno.test("stdin: -- stdin — слово, ввод не читается", async () => {
  const got = await run(["ask"], {
    stdin: bytes("kiten comment id: 11 text: -- stdin"),
    answers: ["y"],
  });
  assertEquals(
    got.stderr,
    "выполнить mpu kiten comment id: 11 text: stdin? [y/N] ",
  );
  assertEquals(got.exit, 0);
  assertEquals(got.posted, ["11 stdin"]);
});

Deno.test("stdin: запись без двери — отказ всей строки с подсказкой ask", async () => {
  const got = await run([], { stdin: bytes("kiten comment id: 5 text: a") });
  assertEquals(
    got.stderr,
    "stdin: строка может записать (kiten comment) — начни с ask: mpu ask\n",
  );
  assertEquals(got.refusals.map((one) => one.hint), [["ask"]]);
  assertEquals(got.exit, 2);
  assertEquals(got.posted, []);
});

Deno.test("stdin: запись через дверь — вопрос человеку", async () => {
  const got = await run(["ask"], {
    stdin: bytes("kiten comment id: 11 text: a"),
    answers: ["y"],
  });
  assertEquals(
    got.stderr,
    "выполнить mpu kiten comment id: 11 text: a? [y/N] ",
  );
  assertEquals(got.exit, 0);
  assertEquals(got.posted, ["11 a"]);
});

Deno.test("stdin: запись журнала — как набрано, без текста программы", async () => {
  const got = await run([], { stdin: bytes("2 plus: 2") });
  assertEquals(got.exit, 0, got.stderr);
  assertEquals(got.native, [""]);
});
