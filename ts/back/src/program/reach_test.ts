/**
 * Обход программы до исполнения (`platform/ask-composite.md`): каждое
 * место, где сообщение уходит команде-листу, известной по разбору, — по
 * порядку строки, в том числе в телах блоков, группах и значениях ключей.
 */

import { assertEquals } from "@std/assert";
import { GRAMMAR } from "../messages/mod.ts";
import {
  type CommandNode,
  type Commands,
  LENIENT_ROOT,
  parseProgram,
} from "./parse.ts";

const {
  open: DO,
  close: END,
  blockEnd: DONE,
  parameter: P,
  variable: V,
  assign: SET,
} = GRAMMAR;

/** Узел поддельного дерева: путь правила — путь листа. */
function node(
  path: string,
  leaf: boolean,
  keys: readonly string[] = [],
): CommandNode {
  return {
    leaf,
    keys: new Map(keys.map((key) => [key, "value" as const])),
    messages: [],
    formats: leaf ? ["json"] : [],
    fromFile: new Map(),
    links: path === "" ? [] : [...path.split(" "), "<rule>"],
    methods: new Map(),
  };
}

const NODES: ReadonlyMap<string, CommandNode> = new Map([
  ["", node("", false)],
  ["kiten", node("kiten", false)],
  ["kiten ls", node("kiten ls", true)],
  ["kiten card", node("kiten card", true, ["id"])],
  ["kiten comment", node("kiten comment", true, ["id", "text"])],
]);

const COMMANDS: Commands = {
  node: (path) => NODES.get(path.join(" ")),
  view: () => {
    throw new Error("обход не исполняет");
  },
};

/** Команды, которые обход строки `line` назвал: путь и звенья. */
function reached(line: string): string[] {
  const found: string[] = [];
  parseProgram(line.split(" "), COMMANDS, LENIENT_ROOT).reach({
    command: (path, links) =>
      void found.push(`${path.join(" ")} [${links.join(" ")}]`),
  });
  return found;
}

Deno.test("обход: достижимые команды по порядку строки", async (t) => {
  const cases: readonly [string, string, readonly string[]][] = [
    ["команда", "kiten ls", ["kiten ls [kiten ls <rule>]"]],
    [
      "тело блока и значение ключа",
      `kiten ls each: ${DO} ${P}c kiten comment id: ${V}c id text: a ${DONE}`,
      ["kiten ls [kiten ls <rule>]", "kiten comment [kiten comment <rule>]"],
    ],
    [
      "присваивание и группа в значении ключа",
      `x ${SET} kiten card id: ${DO} kiten ls ${END} first id ${END}`,
      ["kiten card [kiten card <rule>]", "kiten ls [kiten ls <rule>]"],
    ],
    [
      "аргумент ключевого сообщения — блок",
      `1 to: 2 do: ${DO} ${P}i kiten comment id: ${V}i text: a ${DONE}`,
      ["kiten comment [kiten comment <rule>]"],
    ],
    ["группа — получатель неизвестен", "kiten", []],
    ["без команд", "2 plus: 2", []],
  ];
  for (const [name, line, expected] of cases) {
    await t.step(name, () => assertEquals(reached(line), expected));
  }
});
