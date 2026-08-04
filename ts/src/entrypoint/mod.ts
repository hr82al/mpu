/**
 * Точка входа CLI: маршрутизирует argv по реестру, исполняет команду,
 * печатает её результат и переводит классы ошибок в exit-коды. Печать
 * живёт только здесь — исполнение команды не печатает (инвариант 1
 * `platform/command-contract.md`).
 */

import {
  type Command,
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "../command/mod.ts";
import {
  childrenOf,
  type CommandGroup,
  commands,
  findCommand,
  findGroup,
  findLegacy,
  findSurface,
  legacyCommands,
  surfaces,
} from "../registry/mod.ts";
import { helpEntries, runHelpCommand } from "./help_command.ts";
import { VERSION } from "../version.ts";
import { LegacyBinMissingError, runLegacyCommand } from "../legacy/mod.ts";
import { renderCommandHelp, renderIndex, renderSurfaceHelp } from "./help.ts";

/** Приёмник вывода процесса. */
export interface Output {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const ROOT_USAGE = "mpu <команда> [аргументы]";
const ROOT_SUMMARY =
  "Monorepo Python utilities — multi-purpose CLI for ad-hoc operations.";

/**
 * Общий параметр формы вывода: принимается с любой командой на любом
 * уровне вложенности и в схему аргументов команды не входит
 * (`platform/registry.md`).
 */
const JSON_FLAG = "--json";

/** Имя справочной поверхности: `mpu help [<полное имя>]`. */
const HELP_COMMAND = "help";

/** Имя поверхности версии: `mpu version`. */
const VERSION_COMMAND = "version";

/** Исполняет вызов CLI и возвращает код завершения процесса. */
export async function runCli(
  argv: readonly string[],
  io: CommandIo,
  output: Output,
): Promise<number> {
  const { args: rest, json } = takeJsonFlag(argv);
  if (rest.length === 0) {
    // Вызов без команды: справка печатается, но это ошибка (спека).
    output.stdout(rootIndex());
    return 2;
  }
  if (isHelpRequest(rest[0])) {
    output.stdout(rootIndex());
    return 0;
  }
  if (rest[0].startsWith("-")) {
    output.stderr(`No such option "${rest[0]}"\n`);
    return 2;
  }

  if (rest[0] === VERSION_COMMAND) {
    if (rest.length > 1 && isHelpRequest(rest[1])) {
      output.stdout(renderSurfaceHelp(
        "mpu version",
        findSurface([VERSION_COMMAND])?.summary ?? "",
      ));
      return 0;
    }
    // Версия — константа сборки, а не вопрос к Python-реализации
    // (`platform/registry.md`): одна строка, без префиксов.
    output.stdout(`${VERSION}\n`);
    return 0;
  }

  if (rest[0] === HELP_COMMAND) {
    // Поверхность точки входа, а не запись маршрута: список берётся из
    // единого реестра, поэтому не дрейфует от `--help` (отклонение-fix
    // спеки `platform/registry.md`).
    return await runHelpCommand(
      rest.slice(1),
      helpEntries(commands, legacyCommands, surfaces),
      io,
      output,
    );
  }

  const { path, rest: args } = matchPath(rest);
  if (path.length === 0) {
    output.stderr(noSuchCommand(rest[0]));
    return 2;
  }

  try {
    const legacy = findLegacy(path);
    if (legacy !== undefined) {
      // Аргументы берутся из исходного argv: общий параметр точки
      // входа для этого маршрута не распознаётся и уходит подпроцессу
      // как обычный аргумент (`platform/registry.md`).
      return await runLegacyCommand(legacy, dropPath(argv, path), io, output);
    }
    const command = findCommand(path);
    if (command === undefined) return await runGroup(path, args, io, output);
    if (args.length > 0 && isHelpRequest(args[0])) {
      output.stdout(renderCommandHelp(command));
      return 0;
    }
    return await runCommand(command, args, json, io, output);
  } catch (err) {
    if (err instanceof LegacyBinMissingError) {
      // Сообщение реестра, а не команды: до неё дело не дошло.
      output.stderr(`mpu: ${err.message}\n`);
      return 1;
    }
    if (err instanceof UsageError) {
      output.stderr(`${formatCommandError(path, err)}\n`);
      return 2;
    }
    if (err instanceof DomainError) {
      output.stderr(`${formatCommandError(path, err)}\n`);
      return 1;
    }
    throw err;
  }
}

async function runCommand(
  command: Command,
  args: readonly string[],
  json: boolean,
  io: CommandIo,
  output: Output,
): Promise<number> {
  const result = await command.invoke(args, io);
  if (json) {
    // Структурный результат отдаётся как есть: форма вывода класс
    // команды и её код завершения не меняет.
    output.stdout(JSON.stringify(result, null, 2));
    return 0;
  }
  output.stdout(command.renderResult(result, args));
  return command.textExitCode(result);
}

/**
 * Промежуточный уровень: обычно только индекс, но уровень может нести
 * собственную поверхность голого вызова (`mpu mcp` поднимает сервер).
 */
async function runGroup(
  path: readonly string[],
  args: readonly string[],
  io: CommandIo,
  output: Output,
): Promise<number> {
  const group = findGroup(path);
  if (group === undefined) {
    // Путь опознан по реестру, значит группа обязана быть описана.
    throw new UsageError(`группа "${path.join(" ")}" не описана в реестре`);
  }
  if (args.length > 0 && isHelpRequest(args[0])) {
    output.stdout(groupIndex(group));
    return 0;
  }
  // Подкоманду называет только первый аргумент: дальше идут значения
  // флагов уровня, и они выглядят так же («--profile ro»).
  if (group.bare !== undefined && (args.length === 0 || isFlag(args[0]))) {
    return await group.bare(args, io, output);
  }
  if (args.length === 0) {
    output.stdout(groupIndex(group));
    return 2;
  }
  // Имя вне реестра называется одинаково на любом уровне: ключевые
  // фразы ошибок — фиксируемая часть контракта (`platform/registry.md`).
  output.stderr(noSuchCommand([...path, args[0]].join(" ")));
  return 2;
}

function noSuchCommand(name: string): string {
  return `No such command '${name}'.\nTry 'mpu -h' for help.\n`;
}

/**
 * Снимает общий параметр формы вывода из argv. Всё после `--` —
 * позиционные аргументы команды и не разбирается.
 */
function takeJsonFlag(
  argv: readonly string[],
): { args: readonly string[]; json: boolean } {
  const args: string[] = [];
  let json = false;
  let index = 0;
  for (; index < argv.length; index++) {
    if (argv[index] === "--") break;
    if (argv[index] === JSON_FLAG) {
      json = true;
      continue;
    }
    args.push(argv[index]);
  }
  args.push(...argv.slice(index));
  return { args, json };
}

/**
 * Аргументы без сегментов имени команды. Вырезаются именно они, а не
 * первые N слов: снятый ранее общий параметр мог стоять между ними, и
 * подпроцессу он обязан достаться нетронутым.
 */
function dropPath(
  argv: readonly string[],
  path: readonly string[],
): readonly string[] {
  const rest: string[] = [];
  let matched = 0;
  for (const arg of argv) {
    if (matched < path.length && arg === path[matched]) {
      matched++;
      continue;
    }
    rest.push(arg);
  }
  return rest;
}

/** Самое длинное начало argv, опознанное реестром как путь команды. */
function matchPath(
  argv: readonly string[],
): { path: readonly string[]; rest: readonly string[] } {
  const path: string[] = [];
  let index = 0;
  while (index < argv.length && !argv[index].startsWith("-")) {
    const candidate = [...path, argv[index]];
    if (
      findCommand(candidate) === undefined &&
      findGroup(candidate) === undefined &&
      findLegacy(candidate) === undefined
    ) {
      break;
    }
    path.push(argv[index]);
    index++;
  }
  return { path, rest: argv.slice(index) };
}

function rootIndex(): string {
  return renderIndex(ROOT_USAGE, ROOT_SUMMARY, [...childrenOf([])]);
}

function groupIndex(group: CommandGroup): string {
  return renderIndex(group.usage, group.summary, [...childrenOf(group.path)]);
}

function isHelpRequest(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}

function isFlag(arg: string): boolean {
  return arg.startsWith("-");
}
