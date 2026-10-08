/**
 * Дерево команд и корень для разбора тела метода образа
 * (`platform/image.md`), запись журнала строки образа.
 */

import type { Command } from "@mpu/command";
import { jsonOf, type Output, PRINT } from "../entrypoint/mod.ts";
import { flagged, type KeyKind } from "@mpu/language/messages";
import type { Call } from "@mpu/language/objects";
import {
  callWord,
  type CommandNode,
  type Commands,
  type CommandView,
  type MethodSource,
  type Root,
} from "@mpu/language/program";
import { commands, findCommand } from "../registry/mod.ts";
import { addressesOf, textKeysOf } from "./keyed.ts";
import { formatsOf, registryNodes, ruleLinks } from "./tree.ts";

/** Текст, который печать доставила бы для результата. */
function printed(
  command: Command,
  result: unknown,
  argv: readonly string[],
  json = false,
): string {
  let text = "";
  const output: Output = { stdout: (part) => (text += part), stderr: () => {} };
  PRINT.deliver(command, result, argv, json, output);
  return text;
}

/**
 * Результат команды для программы: вид по умолчанию и форматы — тем же
 * путём, что печатает строка (`… end json`, `… end md`), данные — её
 * `dataOf`.
 */
function commandView(
  command: Command,
  result: unknown,
  argv: readonly string[],
): CommandView {
  const formats: ReadonlyMap<string, () => string> = new Map([
    ["json", () => jsonOf(command, result, argv)],
    ...Object.entries(formatsOf(command.path))
      .filter(([name]) => name !== "json")
      .map(([name, words]): [string, () => string] => [
        name,
        () => printed(command, result, flagged(argv, words)),
      ]),
  ]);
  return {
    data: () => command.dataOf(result, argv),
    formats: () => [...formats.keys()],
    format: (name) => formats.get(name)?.() ?? "",
  };
}

/** Ключ из адреса входа: `body:` → `body`; не ключ — имя входа. */
function keyOf(address: string | undefined, input: string): string {
  if (address === undefined || !address.endsWith(":")) return input;
  return address.slice(0, -1);
}

/**
 * Ключи команды `path`, чей файл читается своим ключом: ключ → ключ
 * файла (`body` → `body-file`); не команда — пусто.
 */
function fileKeys(path: readonly string[]): ReadonlyMap<string, string> {
  const command = findCommand(path);
  if (command === undefined) return new Map();
  const addresses = addressesOf(command, Object.keys(formatsOf(path)));
  return new Map(
    Object.entries(command.fromFile).map(([input, file]) => [
      keyOf(addresses.get(input), input),
      keyOf(addresses.get(file), file),
    ]),
  );
}

/** Ключи-текст команды `path`; не команда — пусто. */
function textKeys(path: readonly string[]): ReadonlySet<string> {
  const command = findCommand(path);
  if (command === undefined) return new Set();
  return new Set(textKeysOf(command, Object.keys(formatsOf(path))));
}

/**
 * Дерево команд реестра для разбора программы — из снимка дерева; вид
 * результата — у самой команды.
 *
 * @param methods методы образа: узел получателя знает свои
 */
export function programCommands(
  methods: readonly MethodSource[] = [],
): Commands {
  const nodes = registryNodes();
  const parents = new Set(
    nodes.map((node) => node.path.slice(0, -1).join(" ")),
  );
  const byPath = new Map(
    nodes.map((node): [string, CommandNode] => {
      const path = node.path.join(" ");
      const own = methods.filter((one) => one.receiver.join(" ") === path);
      return [
        path,
        {
          leaf: node.path.length > 0 && !parents.has(path),
          keys: new Map(
            node.keys.map((key): [string, KeyKind] => [key.name, key.kind]),
          ),
          messages: node.messages.map((line) => line.selector),
          formats: node.formats,
          fromFile: fileKeys(node.path),
          texts: textKeys(node.path),
          links: ruleLinks(node),
          methods: new Map(own.map((one) => [callWord(one.name), one])),
        },
      ];
    }),
  );
  return {
    node: (path) => byPath.get(path.join(" ")),
    view: (path, result, argv) => {
      const command = findCommand(path);
      if (command === undefined) {
        throw new Error(`программе неизвестна команда ${path.join(" ")}`);
      }
      return commandView(command, result, argv);
    },
  };
}

/** Корень строки для разбора программы: его сообщения — от него самого. */
export function programRoot(root: Call): Root {
  const reflection = root.result().reflect();
  return {
    accepts: (word) => reflection.understands(word),
    reserves: (name) => reflection.understands(name),
    messages: () => reflection.messages().map((line) => line.selector),
  };
}

/**
 * Запись журнала о программе целиком: аргументы маскируются, если в ней
 * есть команда, которая свои не журналирует; секция out — так же.
 */
export function programPolicy(words: readonly string[]) {
  const held = commands.filter((command) => holds(words, command.path));
  return {
    logsOutput: true,
    logsArguments: held.every((command) => command.logsArguments),
    logsStdout: held.every((command) => command.logsStdout),
    path: [],
  };
}

/** Есть ли в словах путь подряд. */
function holds(words: readonly string[], path: readonly string[]): boolean {
  return words.some((_, at) => path.every((part, i) => words[at + i] === part));
}
