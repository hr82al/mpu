/**
 * Вызов метода образа в программе (`platform/image.md`, «Вызов и
 * отражение»): сначала согласие ядра строкой вызова со значениями, затем
 * тело блоком со значениями-объектами.
 */

import { assertEquals } from "@std/assert";
import { collectionOf, type Data, dataOf } from "../objects/mod.ts";
import {
  type CommandNode,
  type Commands,
  Every,
  LENIENT_ROOT,
  type LineReply,
  type MethodSource,
  parseProgram,
  type ProgramEnd,
  runProgram,
} from "./mod.ts";

const ROWS = [
  { id: 11, title: "один", column: "review" },
  { id: 12, title: "два", column: "queue" },
  { id: 13, title: "три", column: "review" },
];

function method(receiver: string, name: string, source: string): MethodSource {
  return { receiver: receiver.split(" "), name, source: source.split(" ") };
}

const METHODS: readonly MethodSource[] = [
  method(
    "kiten",
    "cardsIn:",
    "do :col kiten ls where: column is: @col done",
  ),
  method("kiten", "mine", "do kiten ls done"),
  method("kiten", "next:", "do :n @n plus: 1 done"),
  method("kiten", "sum:with:", "do :a :b @a plus: @b done"),
  method(
    "kiten",
    "down:",
    "do :n @n less: 1 ifTrue: do 0 done ifFalse: do kiten down: do @n minus: 1 end done done",
  ),
  method("kiten ls", "first:", "do :n kiten ls done"),
  method("kiten", "keep:", "do :n y := @n done"),
  method("kiten", "bad:", "do :n @n titel done"),
];

function node(
  leaf: boolean,
  path: string,
  messages: readonly string[] = [],
): CommandNode {
  const own = METHODS.filter((one) => one.receiver.join(" ") === path);
  return {
    leaf,
    keys: new Map(),
    messages,
    formats: leaf ? ["json"] : [],
    fromFile: new Map(),
    links: leaf ? [...path.split(" "), "<args>"] : path.split(" "),
    methods: new Map(own.map((one) => [firstWord(one.name), one])),
  };
}

function firstWord(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(0, colon + 1);
}

const NODES: ReadonlyMap<string, CommandNode> = new Map([
  ["kiten", node(false, "kiten", ["ls"])],
  ["kiten ls", node(true, "kiten ls")],
]);

const COMMANDS: Commands = {
  node: (path) => NODES.get(path.join(" ")),
  view: (_path, result) => ({
    data: (): Data =>
      collectionOf((result as { rows: unknown[] }).rows, {
        text: (items) =>
          items.map((item) => `${(item.data() as { title: string }).title}\n`)
            .join(""),
      }),
    formats: () => ["json"],
    format: () => "",
  }),
};

/** Ядро: `kiten ls` — три карточки; согласие — ничего; `refuse` — код. */
function core(lines: string[][], refuse: number) {
  return (words: readonly string[]): Promise<LineReply> => {
    lines.push([...words]);
    if (words[0] === "kiten" && words[1] === "ls" && words.length === 2) {
      return Promise.resolve({
        data: { rows: ROWS },
        command: { path: ["kiten", "ls"], argv: [] },
        shown: "",
      });
    }
    if (refuse !== 0) return Promise.resolve({ exit: refuse });
    return Promise.resolve({ data: dataOf(""), command: null, shown: "" });
  };
}

interface Ran {
  readonly out: string;
  readonly end: ProgramEnd;
  readonly lines: string[][];
}

async function run(line: string, refuse = 0): Promise<Ran> {
  const lines: string[][] = [];
  let out = "";
  const end = await runProgram(line.split(" "), {
    commands: COMMANDS,
    core: core(lines, refuse),
    print: (text) => out += text,
    signal: new AbortController().signal,
    pace: new Every(20, () => performance.now()),
  });
  return { out, end, lines };
}

Deno.test("вызов метода: согласие ядра, затем тело со значением", async () => {
  const ran = await run("kiten cardsIn: review end size");
  assertEquals(ran.out, "2\n");
  assertEquals(ran.end, { exit: 0, refusal: null });
  assertEquals(ran.lines, [["kiten", "cardsIn:", "review"], ["kiten", "ls"]]);
});

Deno.test("унарный метод и метод у команды", async () => {
  assertEquals((await run("kiten mine size")).out, "3\n");
  const ran = await run("kiten ls first: 2 end size");
  assertEquals(ran.out, "3\n");
  assertEquals(ran.lines[0], ["kiten", "ls", "first:", "2"]);
});

Deno.test("значение — объект программы: число остаётся числом", async () => {
  const ran = await run("x := 5 . kiten next: @x");
  assertEquals(ran.out, "6\n");
  assertEquals(ran.lines, [["kiten", "next:", "5"]]);
});

Deno.test("тело метода — своя область: переменная вызывающего цела", async () => {
  const ran = await run("y := 5 . kiten keep: 1 . y");
  assertEquals(ran.out, "5\n");
});

Deno.test("имя из двух частей — два значения по порядку", async () => {
  const two = await run("kiten sum: 2 with: 3");
  assertEquals(two.out, "5\n");
  assertEquals(two.lines, [["kiten", "sum:", "2", "with:", "3"]]);
});

Deno.test("отказ согласия — тело не исполняется, код подстроки наружу", async () => {
  const denied = await run("kiten cardsIn: review", 1);
  assertEquals(denied.lines, [["kiten", "cardsIn:", "review"]]);
  assertEquals(denied.end, { exit: 1, refusal: null });
  const redirected = await run("kiten cardsIn: review", 2);
  assertEquals(redirected.end, { exit: 2, refusal: null });
});

Deno.test("метод зовёт сам себя: согласие на каждый вызов", async () => {
  const ran = await run("kiten down: 3");
  assertEquals(ran.out, "0\n");
  assertEquals(ran.lines.map((line) => line.join(" ")), [
    "kiten down: 3",
    "kiten down: 2",
    "kiten down: 1",
    "kiten down: 0",
  ]);
});

Deno.test("вызов без второй части имени — отказ до исполнения", async () => {
  const ran = await run("kiten sum: 2");
  assertEquals(ran.end.exit, 2);
  assertEquals(ran.lines, []);
  assertEquals(
    ran.end.refusal?.text,
    "выражение 1: метод sum:with: ждёт ключ with:",
  );
});

Deno.test("обход: вызов метода и команды его тела, рекурсия — один раз", () => {
  const found: string[] = [];
  const program = parseProgram(
    "kiten cardsIn: x . kiten down: 2".split(" "),
    COMMANDS,
    LENIENT_ROOT,
  );
  program.reach({ command: (_path, links) => found.push(links.join(" ")) });
  assertEquals(found, [
    "kiten cardsIn:",
    "kiten ls <args>",
    "kiten down:",
    "kiten down:",
  ]);
});

Deno.test("значение-коллекция: в строке вызова — её строчный вид", async () => {
  const ran = await run("x := kiten ls . kiten keep: @x . 1");
  assertEquals(ran.end, { exit: 0, refusal: null });
  // Строчный вид коллекции — её данные JSON одним словом.
  assertEquals(ran.lines[1], ["kiten", "keep:", JSON.stringify(ROWS)]);
});

Deno.test("отказ внутри тела — с местом вызова", async () => {
  const ran = await run("kiten bad: 1");
  assertEquals(ran.end.exit, 1);
  assertEquals(
    ran.end.refusal?.text,
    "выражение 1, блок bad:: число не понимает titel",
  );
});
