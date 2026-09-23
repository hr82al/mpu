/**
 * Вычислитель над поддельным деревом команд и поддельным ядром
 * (`platform/evaluator.md`, «Граничные случаи»). Ядро здесь — функция:
 * она записывает строки, которые ей отдала программа, и отвечает
 * данными трёх карточек.
 */

import { assert, assertEquals } from "@std/assert";
import { GRAMMAR } from "../messages/mod.ts";
import { collectionOf, type Data, dataOf } from "../objects/mod.ts";
import {
  type CommandNode,
  type Commands,
  type CommandView,
  Every,
  isProgram,
  type LineReply,
  parseProgram,
  Placed,
  type ProgramEnd,
  refusalOf,
  type Root,
  runProgram,
} from "./mod.ts";

const { close: END, open: DO, blockEnd: DONE } = GRAMMAR;

const ROWS = [
  { id: 11, title: "один", column: "review", comments: 2, archived: false },
  { id: 12, title: "два", column: "queue", comments: 0 },
  { id: 13, title: "три", column: "review", comments: 5 },
];

/** Узел поддельного дерева: у листа — ключи и форматы `json`, `md`. */
function node(
  leaf: boolean,
  keys: readonly string[],
  messages: readonly string[] = [],
  fromFile: ReadonlyMap<string, string> = new Map(),
): CommandNode {
  return {
    leaf,
    keys: new Map(keys.map((key) => [key, "value" as const])),
    messages,
    formats: leaf ? ["json", "md"] : [],
    fromFile,
    links: [],
    methods: new Map(),
  };
}

/**
 * Имя ключа `kiten close` из реестра («7. Что сделано»): совпадает со
 * словом конца блока, но пишется `done:` — другим словом.
 */
const CLOSE_KEY = "done";

const NODES: ReadonlyMap<string, CommandNode> = new Map([
  ["", node(false, [], ["kiten"])],
  ["kiten", node(false, [], ["card", "close", "ls", "post"])],
  ["kiten ls", node(true, ["column"])],
  ["kiten card", node(true, ["id"])],
  ["kiten close", node(true, ["id", CLOSE_KEY])],
  ["jsdate", node(true, [])],
  [
    "kiten post",
    node(
      true,
      ["id", "body", "body-file"],
      [],
      new Map([["body", "body-file"]]),
    ),
  ],
]);

/** Вид `kiten ls`: названия по строке. */
function titles(records: readonly unknown[]): string {
  return records
    .map((record) => `${(record as { title: string }).title}\n`)
    .join("");
}

function dataFor(path: readonly string[], result: unknown): Data {
  if (path.join(" ") !== "kiten ls") return dataOf(result);
  const rows = (result as { rows: unknown[] }).rows;
  return collectionOf(rows, {
    text: (items) => titles(items.map((item) => item.data())),
  });
}

const FORMATS = ["json", "md"];

/** Формат результата: имя и данные. */
function formatted(name: string, result: unknown): string {
  return `${name}: ${JSON.stringify(result)}\n`;
}

const COMMANDS: Commands = {
  node: (path) => NODES.get(path.join(" ")),
  view: (path, result): CommandView => ({
    data: () => dataFor(path, result),
    formats: () => FORMATS,
    format: (name) => formatted(name, result),
  }),
};

/** Итог команды у ядра: данные, путь и напечатанное — видом или форматом. */
function commandReply(
  path: readonly string[],
  argv: readonly string[],
  data: unknown,
  shown: string,
): Promise<LineReply> {
  const last = argv.at(-1) ?? "";
  const text = FORMATS.includes(last) ? formatted(last, data) : shown;
  return Promise.resolve({ data, command: { path, argv }, shown: text });
}

/**
 * Ядро: `kiten ls` — три карточки, `kiten card id: N` — одна с
 * комментариями, `nope` — отказ до исполнения (код 2), `fail` — отказ
 * исполнения (код 1), прочее — `null`.
 */
function core(lines: string[][]) {
  return (words: readonly string[]): Promise<LineReply> => {
    lines.push([...words]);
    const argv = words.filter((word) => word !== END);
    if (argv[0] === "kiten" && argv[1] === "ls") {
      const data = { rows: ROWS };
      return commandReply(["kiten", "ls"], argv.slice(2), data, titles(ROWS));
    }
    if (argv[0] === "kiten" && argv[1] === "card") {
      const id = Number(argv[3]);
      const row = ROWS.find((one) => one.id === id);
      const comments = Array.from({ length: row?.comments ?? 0 }, (_, i) => i);
      const data = { id, comments };
      return commandReply(
        ["kiten", "card"],
        argv.slice(2),
        data,
        `${JSON.stringify(data)}\n`,
      );
    }
    if (argv[0] === "jsdate") {
      const data = { stamp: "20260923" };
      return commandReply(["jsdate"], [], data, "20260923\n");
    }
    if (argv[0] === "nope") return Promise.resolve({ exit: 2 });
    if (argv[0] === "fail") return Promise.resolve({ exit: 1 });
    return Promise.resolve({ data: null, command: null, shown: "" });
  };
}

interface Ran {
  readonly out: string;
  readonly end: ProgramEnd;
  readonly lines: string[][];
}

async function run(
  line: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<Ran> {
  const lines: string[][] = [];
  let out = "";
  const end = await runProgram(line.split(" "), {
    commands: COMMANDS,
    core: core(lines),
    print: (text) => out += text,
    signal,
    pace: new Every(20, () => performance.now()),
  });
  return { out, end, lines };
}

const PRINTS: readonly (readonly [string, string])[] = [
  ["x := 5 . x plus: 2", "7\n"],
  ["x := 5 . x plus: 2 print", "7\n"],
  ["3 greater: 2", "true\n"],
  [`3 greater: 2 ifTrue: ${DO} ^да^ print ${DONE}`, "да\n"],
  [`1 greater: 2 ifTrue: ${DO} ^да^ print ${DONE}`, ""],
  [
    `3 greater: 2 ifTrue: ${DO} ^да^ ${DONE} ifFalse: ${DO} ^нет^ ${DONE}`,
    "да\n",
  ],
  [
    `1 greater: 2 ifTrue: ${DO} ^да^ ${DONE} ifFalse: ${DO} ^нет^ ${DONE}`,
    "нет\n",
  ],
  [`1 to: 3 do: ${DO} :i i print ${DONE}`, "1\n2\n3\n"],
  [`3 timesRepeat: ${DO} ^x^ print ${DONE}`, "x\nx\nx\n"],
  ["10 div: 4", "2\n"],
  ["-7 div: 2", "-4\n"],
  ["1250 dividedBy: 8", "156.25\n"],
  ["^готово к ревью^ size", "14\n"],
  ["^^ size", "0\n"],
  [`rem проверка ${END} 2 plus: 2`, "4\n"],
  ["x := kiten ls . x size", "3\n"],
  [
    `x := kiten ls . x where: column is: review ${END} each: ${DO} :c c title print ${DONE} . x size print`,
    "один\nтри\n3\n",
  ],
  [`kiten ls collect: ${DO} :c c id ${DONE} print`, "11\n12\n13\n"],
  [`kiten ls inject: 0 into: ${DO} :a :c @a plus: 1 ${DONE}`, "3\n"],
  [`kiten ls detect: ${DO} :c c id equals: 999999 ${DONE}`, ""],
  [`kiten ls detect: ${DO} :c c id equals: 12 ${DONE} title`, "два\n"],
  [
    `kiten ls each: ${DO} :c kiten card id: @c id ${END} comments size print ${DONE}`,
    "2\n0\n5\n",
  ],
  [`b := ${DO} :x @x plus: 1 ${DONE} . b value: 2`, "3\n"],
  [`kiten ls where: column is: ${DONE} ${END} size`, "0\n"],
  ["2 print . 3", "2\n3\n"],
  ["x := kiten ls", "один\nдва\nтри\n"],
  [`x := kiten ls . x where: column is: review`, "один\nтри\n"],
  ["^a^ equals: 1", "false\n"],
  ["^Готово^ includes: гот", "true\n"],
  ["^b^ greater: ^a^", "true\n"],
  [`true := 1 . @true`, "1\n"],
  [`kiten ls select: ${DO} :c c comments greater: 1 ${DONE} size`, "2\n"],
  [`kiten ls reject: ${DO} :c c comments greater: 1 ${DONE} size`, "1\n"],
  ["kiten card id: 11 md", 'md: {"id":11,"comments":[0,1]}\n'],
  [
    `x := kiten ls ${END} json . x size`,
    `${[...'json: {"rows":' + JSON.stringify(ROWS) + "}"].length}\n`,
  ],
  ["x := 1 . x isNil", "false\n"],
  [`3 greater: 2 and: ${DO} 1 less: 2 ${DONE}`, "true\n"],
  [`1 greater: 2 and: ${DO} 1 less: 2 ${DONE}`, "false\n"],
  [`1 greater: 2 or: ${DO} 1 less: 2 ${DONE}`, "true\n"],
  [`3 greater: 2 or: ${DO} 1 less: 2 ${DONE}`, "true\n"],
  ["3 greater: 2 not", "false\n"],
  ["1 greater: 2 not", "true\n"],
  [`1 greater: 2 ifFalse: ${DO} ^нет^ ${DONE}`, "нет\n"],
  [`3 greater: 2 ifFalse: ${DO} ^нет^ ${DONE}`, ""],
  ["2 times: 3 minus: 1", "5\n"],
  ["^a^ less: ^b^", "true\n"],
  ["^a^ equals: ^a^", "true\n"],
  ["3 equals: 3", "true\n"],
  ["3 equals: ^3^", "false\n"],
  ["^a3^ includes: 3", "true\n"],
  [`x := kiten ls collect: ${DO} :c c id ${DONE} . x size`, "3\n"],
  [`x := kiten ls collect: ${DO} :c c id ${DONE} . x first`, "11\n"],
  [`x := kiten ls collect: ${DO} :c c id ${DONE} . x last`, "13\n"],
  [`x := kiten ls collect: ${DO} :c c id ${DONE} . x isEmpty`, "false\n"],
  [
    `x := kiten ls select: ${DO} :c c id equals: 0 ${DONE} . x first isNil`,
    "true\n",
  ],
  [`kiten ls collect: ${DO} :c c ${DONE} first title`, "один\n"],
  ["3 understands: -- plus:", "true\n"],
  ["3 understands: nope", "false\n"],
  ["3 formats", "json\n"],
  ["3 keys", ""],
  ["3 variants", ""],
  ["3 json", "3\n"],
  [
    `x := kiten ls ${END} first . x json`,
    '{\n  "id": 11,\n  "title": "один",\n  "column": "review",\n  "comments": 2,\n  "archived": false\n}\n',
  ],
  [`b := ${DO} :x @x ${DONE} . b print`, "блок\n"],
  [`kiten card id: ${DO} jsdate ${END}`, '{"id":20260923,"comments":[]}\n'],
  [`x := kiten ls ${END} first . x pick: title`, "один\n"],
  [`kiten ls where: column is: review ${END} size`, "2\n"],
  ["x := kiten ls . x print . 1", "один\nдва\nтри\n1\n"],
  ["x := kiten ls . x md", `md: ${JSON.stringify({ rows: ROWS })}\n`],
  [`x := kiten ls ${END} first archived`, "false\n"],
  [
    `kiten ls collect: ${DO} :c c ${DONE} last`,
    "id\t13\ntitle\tтри\ncolumn\treview\ncomments\t5\n",
  ],
  [`kiten ls detect: ${DO} :c c id equals: 0 ${DONE} isNil`, "true\n"],
];

Deno.test("программа печатает значение последнего выражения", async (t) => {
  for (const [line, out] of PRINTS) {
    await t.step(line, async () => {
      const ran = await run(line);
      assertEquals(ran.end, { exit: 0, refusal: null });
      assertEquals(ran.out, out);
    });
  }
});

const REFUSALS: readonly (readonly [string, string, number])[] = [
  ["3 greater: ^a^", "выражение 1: сравнение числа и текста", 1],
  ["10 div: 0", "выражение 1: деление на ноль", 1],
  ["^a b", "выражение 1: текст не закрыт", 2],
  [
    `kiten ls each: ${DO} :c kiten card id: c ${DONE}`,
    "выражение 1, блок each:: переменная в значении — @c; текст — -- c",
    2,
  ],
  [
    `kiten ls each: ${DO} :c @c titel print ${DONE}`,
    "выражение 1, блок each:: запись не понимает titel; ближайшие: title",
    1,
  ],
  [
    `b := ${DO} :x :y @x ${DONE} . b value: 1`,
    "выражение 2: блок ждёт 2 значений, дано 1",
    1,
  ],
  ["@y size", "выражение 1: y не связана; связанных нет", 2],
  [
    "x := 1 . kiten card id: @y",
    "выражение 2: y не связана; связаны: x; текстом — -- @y",
    2,
  ],
  ["@c.title", "выражение 1: поле — унарным: @c title", 2],
  [
    `kiten ls eatch: ${DO} :c c ${DONE}`,
    "выражение 1: коллекция не понимает eatch:; ближайшие: each:",
    2,
  ],
  ["x := 5 . x titel", "выражение 2: число не понимает titel", 1],
  ["3 plus: ^a^", "выражение 1: plus: ждёт число", 1],
  ["3 value", "выражение 1: число не понимает value", 1],
  ["5 timesRepeat: 3", "выражение 1: число не понимает value", 1],
  [
    `kiten ls select: ${DO} :c 1 ${DONE}`,
    "выражение 1: select: ждёт true или false",
    1,
  ],
  [
    `kiten card id: ${DO} kiten ls ${END}`,
    "выражение 1: значение ключа id — не скаляр (список)",
    1,
  ],
  [
    `x := kiten ls ${END} first . kiten card id: @x`,
    "выражение 2: значение ключа id — не скаляр (запись)",
    1,
  ],
  [
    `b := ${DO} :x @x ${DONE} . kiten card id: @b`,
    "выражение 2: значение ключа id — не скаляр (блок)",
    1,
  ],
  [
    `x := kiten ls detect: ${DO} :c 1 less: 0 ${DONE} . kiten card id: @x`,
    "выражение 2: значение ключа id — не скаляр (nil)",
    1,
  ],
  ["x := 1 . x nope", "выражение 2: число не понимает nope", 1],
  ["x := kiten ls . x value", "выражение 2: коллекция не понимает value", 1],
  ["x := kiten ls . 3 plus: @x", "выражение 2: plus: ждёт число", 1],
  [
    `x := kiten ls . kiten ls select: ${DO} :c @x ${DONE}`,
    "выражение 2: select: ждёт true или false",
    1,
  ],
  [
    `x := kiten ls ${END} first . x value`,
    "выражение 2: запись не понимает value; ближайшие: id, title, column, comments, archived",
    1,
  ],
  [
    `x := kiten ls ${END} first . 3 less: @x`,
    "выражение 2: не сравнивается",
    1,
  ],
  [
    "x := kiten ls . x eatch: 1",
    "выражение 2: коллекция не понимает eatch:; ближайшие: each:",
    1,
  ],
  ["^b^ greater: 1", "выражение 1: сравнение числа и текста", 1],
  [
    `x := kiten ls ${END} first . x less: 1`,
    "выражение 2: запись не понимает less:; ближайшие: id, title, column, comments, archived",
    1,
  ],
  [`${DO} :x @x`, `выражение 1: ${DO} не закрыт`, 2],
  ["x := 1 . . 2", "выражение 2: пустое выражение", 2],
];

Deno.test("отказы программы: текст с местом и код", async (t) => {
  for (const [line, text, exit] of REFUSALS) {
    await t.step(line, async () => {
      const ran = await run(line);
      assertEquals(ran.end.refusal?.text, text);
      assertEquals(ran.end.exit, exit);
    });
  }
});

Deno.test("отказ до исполнения ничего не исполняет", async () => {
  const lines = [
    `kiten ls each: ${DO} :c kiten card id: c ${DONE}`,
    `kiten ls eatch: ${DO} :c c ${DONE}`,
    `kiten ls . @y`,
  ];
  for (const line of lines) {
    const ran = await run(line);
    assertEquals(ran.lines, [], line);
    assertEquals(ran.end.exit, 2, line);
  }
});

Deno.test("деление склеенного: команде — её ключи, результату — остаток", async () => {
  const ran = await run(
    `kiten ls column: review each: ${DO} :c c id print ${DONE}`,
  );
  assertEquals(ran.lines, [["kiten", "ls", "column:", "review"]]);
  assertEquals(ran.out, "11\n12\n13\n");
});

Deno.test("унарное после литерала — результату команды, а не значению", async () => {
  const ran = await run("x := 1 . kiten card id: 11 md");
  // Формат за значением — сообщение результату команды ([D.8]): он уходит
  // строкой команды, а не становится частью значения.
  assertEquals(ran.lines, [["kiten", "card", "id:", "11", "md"]]);
  assertEquals(ran.out, 'md: {"id":11,"comments":[0,1]}\n');
});

Deno.test("ключ done: блок не закрывает — это другое слово, чем конец блока", async () => {
  const ran = await run(
    `kiten ls each: ${DO} :c kiten close id: @c id ${CLOSE_KEY}: x ${DONE}`,
  );
  assertEquals(ran.lines.slice(1).map((line) => line.join(" ")), [
    `kiten close id: 11 ${CLOSE_KEY}: x`,
    `kiten close id: 12 ${CLOSE_KEY}: x`,
    `kiten close id: 13 ${CLOSE_KEY}: x`,
  ]);
});

Deno.test("значение ключа команды — текст выражения, словом-литералом", async () => {
  const ran = await run(`x := ^${END}^ . kiten card id: @x`);
  assertEquals(ran.lines, [["kiten", "card", "id:", "--", END]]);
});

Deno.test("одна ближайшая — подсказка строкой с заменённым словом", async () => {
  const ran = await run(`kiten ls each: ${DO} :c @c titel print ${DONE}`);
  assertEquals(ran.end.refusal?.hint, [
    "kiten",
    "ls",
    "each:",
    DO,
    ":c",
    "@c",
    "title",
    "print",
    DONE,
  ]);
  assertEquals(ran.end.refusal?.candidates, ["title"]);
});

Deno.test("@путь значением ключа с файлом своим ключом — отказ с готовой строкой", async (t) => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    [
      "kiten post id: 1 body: @req.json",
      ["kiten", "post", "id:", "1", "body-file:", "req.json"],
    ],
    [
      "x := 1 . kiten post id: 1 --body=@req.json",
      [
        "x",
        ":=",
        "1",
        ".",
        "kiten",
        "post",
        "id:",
        "1",
        "body-file:",
        "req.json",
      ],
    ],
    [
      "x := 1 . kiten post id: 1 body: -- @req.json",
      [
        "x",
        ":=",
        "1",
        ".",
        "kiten",
        "post",
        "id:",
        "1",
        "body-file:",
        "req.json",
      ],
    ],
  ];
  for (const [line, hint] of cases) {
    await t.step(line, async () => {
      const ran = await run(line);
      assertEquals(ran.end.exit, 2);
      assertEquals(
        ran.end.refusal?.text.endsWith(
          "файл — ключом: mpu kiten post id: 1 body-file: req.json",
        ),
        true,
        ran.end.refusal?.text,
      );
      assertEquals(ran.end.refusal?.hint, hint);
      assertEquals(ran.lines, []);
    });
  }
});

Deno.test("несвязанная @x в значении ключа команды — подсказка текстом", async () => {
  const ran = await run("kiten card id: @all");
  assertEquals(ran.end.refusal?.hint, ["kiten", "card", "id:", "--", "@all"]);
  assertEquals(ran.end.refusal?.reason, "не связана");
});

Deno.test("рекурсия блока через переменную на глубину 100 000", async () => {
  const line = `f := ${DO} :n @n less: 1 ifTrue: ${DO} 0 ${DONE} ifFalse: ` +
    `${DO} @f value: ${DO} @n minus: 1 ${END} ${DONE} ${DONE} . f value: 100000`;
  const ran = await run(line);
  assertEquals(ran.end, { exit: 0, refusal: null });
  assertEquals(ran.out, "0\n");
});

Deno.test("отмена останавливает бесконечный цикл, код 130", async () => {
  const stop = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => stop.abort(), 50);
  try {
    const ran = await run(
      `1 to: 1000000000 do: ${DO} :i i ${DONE}`,
      stop.signal,
    );
    assertEquals(ran.end, { exit: 130, refusal: null });
  } finally {
    clearTimeout(timer);
  }
  assert(performance.now() - started < 1000, "остановка дольше секунды");
});

Deno.test("строка команды с кодом ≠ 0 — программа кончается", async (t) => {
  // Отказ до исполнения (2) — как есть, прочий — 1 (`ask-composite.md`).
  const cases: readonly [string, number][] = [["nope", 2], ["fail", 1]];
  for (const [word, exit] of cases) {
    await t.step(word, async () => {
      const ran = await run(`x := 1 . ${word} . 2 print`);
      assertEquals(ran.end, { exit, refusal: null });
      assertEquals(ran.out, "");
    });
  }
});

/** Корень строки: понимает `kiten` и `it`. */
const ROOT: Root = {
  accepts: (word) => ["kiten", "it", "help"].includes(word),
  reserves: (name) => ["kiten", "it", "help"].includes(name),
  messages: () => ["help", "it", "kiten"],
};

function refusedText(line: string): string {
  const words = line.split(" ");
  try {
    parseProgram(words, COMMANDS, ROOT);
  } catch (err) {
    if (!(err instanceof Placed)) throw err;
    return refusalOf(words, err).text();
  }
  throw new Error(`разбор не отказал: ${line}`);
}

Deno.test("отказы разбора с корнем строки", () => {
  assertEquals(
    refusedText("kiten := 1"),
    "выражение 1: kiten — сообщение корня, выбери другое имя",
  );
  assertEquals(
    refusedText(`${DONE} := 1`),
    `выражение 1: ${DONE} — слово грамматики, выбери другое имя`,
  );
  assertEquals(
    refusedText("kiten ls . kitn"),
    "выражение 2: mpu: не понимает kitn; ближайшие: kiten",
  );
  assertEquals(
    refusedText("x := 1 . kiten lss"),
    "выражение 2: mpu kiten: не понимает lss; ближайшие: ls",
  );
});

Deno.test("строка — программа по словам, --  экранирует", () => {
  const cases: readonly (readonly [string, boolean])[] = [
    ["kiten ls", false],
    [`${DO} kiten ls ${END} size`, false],
    ["kiten ls size.", false],
    ["kiten ls . x", true],
    ["x := 1", true],
    ["3 greater: 2", true],
    ["^a^ size", true],
    ["kiten card id: @x", true],
    [`kiten ls each: ${DO} :c c ${DONE}`, true],
    [`rem a ${END} kiten ls`, true],
    ["text: -- .", false],
    ["text: -- @x", false],
  ];
  for (const [line, program] of cases) {
    assertEquals(isProgram(line.split(" ")), program, line);
  }
});
