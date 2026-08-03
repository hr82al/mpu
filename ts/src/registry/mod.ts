/**
 * Реестр команд: единственный список, который читают маршрутизация и
 * все справочные поверхности, — рассинхрон списков невозможен по
 * построению (`platform/registry.md`).
 *
 * Группа — промежуточный уровень дерева (`mpu xlsx`, `mpu xlsx alias`);
 * своей реализации у неё нет, но однострока обязательна: без неё
 * индекс родителя нечем собрать.
 */

import type { Command } from "../command/mod.ts";
import { xlsxCommands } from "../xlsx/mod.ts";

/** Промежуточный уровень дерева команд. */
export interface CommandGroup {
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: string;
}

/** Все команды CLI в порядке показа в справке. */
export const commands: readonly Command[] = xlsxCommands;

/** Все промежуточные уровни; каждый префикс пути команды описан здесь. */
export const groups: readonly CommandGroup[] = [
  {
    path: ["xlsx"],
    summary: "чтение локальных .xlsx: листы, значения, алиасы",
    usage: "mpu xlsx <подкоманда> [аргументы]",
  },
  {
    path: ["xlsx", "alias"],
    summary: "алиасы путей: add | ls | rm",
    usage: "mpu xlsx alias <подкоманда> [аргументы]",
  },
];

/** Команда с ровно таким путём; для префикса группы — `undefined`. */
export function findCommand(path: readonly string[]): Command | undefined {
  return commands.find((command) => samePath(command.path, path));
}

/** Группа с ровно таким путём. */
export function findGroup(path: readonly string[]): CommandGroup | undefined {
  return groups.find((group) => samePath(group.path, path));
}

/**
 * Что доступно непосредственно под этим путём: имя следующего сегмента
 * и его однострока. Порядок — порядок реестра, не алфавит.
 */
export function childrenOf(
  prefix: readonly string[],
): readonly { name: string; summary: string }[] {
  const seen = new Set<string>();
  const out: { name: string; summary: string }[] = [];
  for (const command of commands) {
    if (!startsWith(command.path, prefix)) continue;
    const name = command.path[prefix.length];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const childPath = [...prefix, name];
    const group = findGroup(childPath);
    const summary = group?.summary ??
      findCommand(childPath)?.summary ?? "";
    out.push({ name, summary });
  }
  return out;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((segment, i) => segment === right[i]);
}

function startsWith(
  path: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.length <= path.length &&
    prefix.every((segment, i) => segment === path[i]);
}
