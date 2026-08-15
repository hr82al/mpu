/**
 * Реестр команд: единственный список, который читают маршрутизация и
 * все справочные поверхности, — рассинхрон списков невозможен по
 * построению (`platform/registry.md`).
 *
 * Группа — промежуточный уровень дерева (`mpu xlsx`, `mpu xlsx alias`);
 * своей реализации у неё нет, но однострока обязательна: без неё
 * индекс родителя нечем собрать.
 *
 * Маршрут выражен не признаком записи, а тем, в каком списке она
 * лежит: `commands` исполняются кодом CLI и подчиняются контракту
 * команды, `legacyCommands` — подпроцессом Python-реализации, и ни
 * схем, ни рендера у них нет. Обход инвариантов контракта идёт по
 * `commands` и потому фильтрует записи по маршруту по построению
 * (`platform/command-contract.md`).
 */

import type { Command, CommandIo } from "../command/mod.ts";
import type { LegacyCommand } from "../legacy/mod.ts";
import { LEGACY_TREE } from "./legacy_tree.ts";
import { xlsxCommands } from "../xlsx/mod.ts";
import { initCommand } from "../init/mod.ts";
import { updateCommand } from "../update/mod.ts";
import { mcpTokenCommand } from "../mcp/cmd_token.ts";
import { sqlRoCommand } from "../sqlro/mod.ts";
import { logsCommand } from "../logs/mod.ts";
import {
  kitenArtefactRmCommand,
  kitenArtefactSetCommand,
  kitenCardCommand,
  kitenCommentCommand,
  kitenFieldSetCommand,
} from "../kiten/mod.ts";
import { type ErrorSink, runMcpServer } from "../mcp/cli.ts";
import type { InvokeLog } from "../invokelog/mod.ts";

/**
 * Что делает голый вызов уровня (`mpu mcp`), если он делает не индекс.
 * Возвращает код завершения процесса.
 */
type BareHandler = (
  argv: readonly string[],
  io: CommandIo,
  output: ErrorSink,
  /** Журнал вызовов: сервер пишет запись на каждый вызов тула. */
  log: InvokeLog,
) => Promise<number>;

/**
 * Поверхность точки входа: запись реестра со строкой использования.
 * Подробной справки у неё нет — назначение исчерпывается однострокой,
 * поэтому `mpu help <имя>` и `<имя> --help` печатают одно и то же
 * (`platform/registry.md`, отклонение про именованный рендер).
 */
export interface SurfaceCommand {
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: string;
}

/** Промежуточный уровень дерева команд. */
export interface CommandGroup {
  readonly path: readonly string[];
  readonly summary: string;
  readonly usage: string;
  /**
   * Поверхность голого вызова уровня. Есть только у `mpu mcp`: сервер
   * не команда контракта — у него нет результата, который рендерится
   * (см. `mcp/cli.ts`).
   */
  readonly bare?: BareHandler;
}

/** Все команды CLI в порядке показа в справке. */
export const commands: readonly Command[] = [
  ...xlsxCommands,
  initCommand,
  updateCommand,
  sqlRoCommand,
  logsCommand,
  mcpTokenCommand,
  // Первый нативный лист внутри группы, оставшейся `legacy`: соседи
  // `kiten` уходят подпроцессом одной записью слепка, а этот путь
  // распознаётся реестром целиком и потому побеждает её длиной.
  kitenCardCommand,
  kitenCommentCommand,
  kitenFieldSetCommand,
  kitenArtefactSetCommand,
  kitenArtefactRmCommand,
];

/**
 * Команды, ещё не переехавшие: исполняются подпроцессом Python-версии.
 * Состав и однострокѝ порождены из машинного слепка дерева
 * (`legacy_tree.ts`); перевод команды на маршрут `native` — перенос
 * записи отсюда в `commands` (`platform/registry.md`).
 */
export const legacyCommands: readonly LegacyCommand[] = LEGACY_TREE;

/**
 * Поверхности точки входа: исполняются кодом CLI, но командами
 * контракта не являются — ни схем, ни результата у них нет. `mpu help`
 * печатает список из единого реестра (`platform/registry.md`), `mpu mcp`
 * поднимает долгоживущий процесс (`platform/command-contract.md`).
 *
 * Однострока `help` — из слепка дерева: поверхность своя, но имя и
 * описание унаследованы, и расхождение с оригиналом здесь ни к чему.
 */
export const surfaces: readonly SurfaceCommand[] = [
  {
    path: ["help"],
    summary: "Список всех mpu команд с опциональной справкой.",
    usage: "mpu help [<полное имя команды>]",
  },
  {
    path: ["version"],
    summary: "Show mpu version.",
    usage: "mpu version",
  },
];

/** Поверхность точки входа с ровно таким путём. */
export function findSurface(
  path: readonly string[],
): SurfaceCommand | undefined {
  return surfaces.find((surface) => samePath(surface.path, path));
}

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
  {
    path: ["kiten", "field"],
    summary: "кастомные поля карточки: set | artefact",
    usage: "mpu kiten field <подкоманда> [аргументы]",
  },
  {
    path: ["kiten", "field", "artefact"],
    summary: "файловое поле «9. AI-артефакт»: set | rm",
    usage: "mpu kiten field artefact <подкоманда> [аргументы]",
  },
  {
    path: ["mcp"],
    summary: "MCP-сервер над реестром команд: запуск и токен доступа",
    usage: "mpu mcp [--profile ro|rw|ro,rw] [--port N]",
    bare: (argv, io, output, log) =>
      runMcpServer(argv, { io, output, commands, log }),
  },
];

/** Команда с ровно таким путём; для префикса группы — `undefined`. */
export function findCommand(path: readonly string[]): Command | undefined {
  return commands.find((command) => samePath(command.path, path));
}

/** Запись маршрута `legacy` с ровно таким путём. */
export function findLegacy(
  path: readonly string[],
): LegacyCommand | undefined {
  return legacyCommands.find((command) => samePath(command.path, path));
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
  // Ни маршрут, ни способ исполнения на состав справки не влияют:
  // индекс перечисляет всё дерево команд (`platform/registry.md`).
  for (const command of [...commands, ...legacyCommands, ...surfaces]) {
    if (!startsWith(command.path, prefix)) continue;
    const name = command.path[prefix.length];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const childPath = [...prefix, name];
    const group = findGroup(childPath);
    const summary = group?.summary ??
      findCommand(childPath)?.summary ??
      findLegacy(childPath)?.summary ??
      findSurface(childPath)?.summary ?? "";
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
