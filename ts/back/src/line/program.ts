/**
 * Программа глазами ядра (`platform/evaluator.md`, «Где исполняется»):
 * дерево команд и корень для разбора, вид результата команды для печати
 * программы, доставка подстроки, место исполнения программы.
 */

import type { Command, CommandIo } from "../command/mod.ts";
import {
  type Delivery,
  type InvokeJournal,
  jsonOf,
  type Output,
  PRINT,
  withoutJsonFlag,
} from "../entrypoint/mod.ts";
import { flagged, type KeyKind } from "../messages/mod.ts";
import type { Call } from "../objects/mod.ts";
import {
  type CommandNode,
  type Commands,
  type CommandView,
  DEFAULT_PACE_MS,
  Every,
  type LineReply,
  type ProgramEnd,
  type Root,
  runProgram,
} from "../program/mod.ts";
import { commands, findCommand } from "../registry/mod.ts";
import { addressesOf } from "./keyed.ts";
import { formatsOf, registryNodes } from "./tree.ts";

/** Текст, который печать доставила бы для результата. */
function printed(
  command: Command,
  result: unknown,
  argv: readonly string[],
  json = false,
): string {
  let text = "";
  const output: Output = { stdout: (part) => text += part, stderr: () => {} };
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

/**
 * Дерево команд реестра для разбора программы — из снимка дерева; вид
 * результата — у самой команды.
 */
export function programCommands(): Commands {
  const nodes = registryNodes();
  const parents = new Set(
    nodes.map((node) => node.path.slice(0, -1).join(" ")),
  );
  const byPath = new Map(nodes.map((node): [string, CommandNode] => {
    const path = node.path.join(" ");
    return [path, {
      leaf: node.path.length > 0 && !parents.has(path),
      keys: new Map(
        node.keys.map((key): [string, KeyKind] => [key.name, key.kind]),
      ),
      messages: node.messages.map((line) => line.selector),
      formats: node.formats,
      fromFile: fileKeys(node.path),
    }];
  }));
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

/** Что взяла доставка подстроки. */
interface Take {
  /** Ответ программе по коду строки и её напечатанному. */
  reply(code: number, printed: string): LineReply;
}

/**
 * Команда до результата не дошла: код — как есть; строка без команды
 * (`it`, справка) — её напечатанное данными JSON, не JSON — текстом.
 */
const NOTHING_TAKEN: Take = {
  reply(code, text) {
    if (code !== 0) return { exit: code };
    return { data: dataOfText(text), command: null, shown: text };
  },
};

function dataOfText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return text.replace(/\n$/, "");
  }
}

/**
 * Доставка подстроки программы: результат команды не печатается, а
 * уходит программе данными с путём и аргументами — вид и форматы она
 * нарисует им же.
 */
export class Capture implements Delivery {
  #taken: Take = NOTHING_TAKEN;

  deliver(
    command: Command,
    result: unknown,
    args: readonly string[],
    json: boolean,
  ) {
    const argv = withoutJsonFlag(args);
    // Текст — тот, что строка напечатала бы: с её форматом.
    const shown = printed(command, result, args, json);
    this.#taken = {
      reply: () => ({
        data: result,
        command: { path: command.path, argv },
        shown,
      }),
    };
    return command.textExitCode(result);
  }

  reply(code: number, text: string): LineReply {
    return this.#taken.reply(code, text);
  }
}

/**
 * Запись журнала о программе целиком: аргументы маскируются, если в ней
 * есть команда, которая свои не журналирует.
 */
export function programPolicy(words: readonly string[]) {
  const masked = commands.some((command) =>
    !command.logsArguments && holds(words, command.path)
  );
  return { logsOutput: true, logsArguments: !masked, path: [] };
}

/** Есть ли в словах путь подряд. */
function holds(words: readonly string[], path: readonly string[]): boolean {
  return words.some((_, at) => path.every((part, i) => words[at + i] === part));
}

/**
 * Где исполняется программа строки: у сервера строк — исполнитель вне
 * предела пула (`platform/evaluator.md`), у прочих — здесь же.
 */
export interface Evaluator {
  /**
   * Итог программы `words`; команды она отдаёт `core` отдельными
   * строками, печать — в stdout `output`.
   */
  evaluate(
    words: readonly string[],
    io: CommandIo,
    output: Output,
    core: (words: readonly string[]) => Promise<LineReply>,
    journal: InvokeJournal,
  ): Promise<ProgramEnd>;
}

/** Программа исполняется здесь же, в процессе вызывающего. */
export const IN_PLACE_PROGRAMS: Evaluator = {
  evaluate: (words, io, output, core) =>
    runProgram(words, {
      commands: programCommands(),
      core,
      print: output.stdout,
      signal: io.signal,
      pace: new Every(DEFAULT_PACE_MS, () => performance.now()),
    }),
};
