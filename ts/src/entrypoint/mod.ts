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
  UsageError,
} from "../command/mod.ts";
import {
  childrenOf,
  type CommandGroup,
  findCommand,
  findGroup,
} from "../registry/mod.ts";
import { renderCommandHelp, renderIndex } from "./help.ts";

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

  const { path, rest: args } = matchPath(rest);
  if (path.length === 0) {
    output.stderr(`No such command '${rest[0]}'.\nTry 'mpu -h' for help.\n`);
    return 2;
  }

  try {
    const command = findCommand(path);
    if (command === undefined) return runGroup(path, args, output);
    if (args.length > 0 && isHelpRequest(args[0])) {
      output.stdout(renderCommandHelp(command));
      return 0;
    }
    return await runCommand(command, args, json, io, output);
  } catch (err) {
    if (err instanceof UsageError) {
      output.stderr(`${errorLine(path, err)}\n`);
      return 2;
    }
    if (err instanceof DomainError) {
      output.stderr(`${errorLine(path, err)}\n`);
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

/** Промежуточный уровень: собственной реализации нет, только индекс. */
function runGroup(
  path: readonly string[],
  args: readonly string[],
  output: Output,
): number {
  const group = findGroup(path);
  if (group === undefined) {
    // Путь опознан по реестру, значит группа обязана быть описана.
    throw new UsageError(`группа "${path.join(" ")}" не описана в реестре`);
  }
  if (args.length === 0) {
    output.stdout(groupIndex(group));
    return 2;
  }
  if (isHelpRequest(args[0])) {
    output.stdout(groupIndex(group));
    return 0;
  }
  throw new UsageError(`unknown subcommand "${args[0]}"`, {
    hint: `mpu ${path.join(" ")} --help`,
  });
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

/** Самое длинное начало argv, опознанное реестром как путь команды. */
function matchPath(
  argv: readonly string[],
): { path: readonly string[]; rest: readonly string[] } {
  const path: string[] = [];
  let index = 0;
  while (index < argv.length && !argv[index].startsWith("-")) {
    const candidate = [...path, argv[index]];
    if (
      findCommand(candidate) === undefined && findGroup(candidate) === undefined
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

/**
 * Строка stderr: `mpu <команда>: <причина>[; попробуй: <подсказка>]`.
 * Префикс — первый сегмент пути, а не весь путь: он называет команду,
 * с которой разговаривает пользователь (контракт спек команд).
 */
function errorLine(
  path: readonly string[],
  err: UsageError | DomainError,
): string {
  const hint = err.hint === undefined ? "" : `; попробуй: ${err.hint}`;
  return `mpu ${path[0]}: ${err.message}${hint}`;
}
