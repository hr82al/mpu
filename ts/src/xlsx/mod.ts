/**
 * Публичная поверхность команды `mpu xlsx`: диспетчер подкоманд и
 * перевод типизированных ошибок в stderr/exit-код по контракту спеки
 * xlsx.md. Зависимости от окружения передаются через `XlsxIo`
 * (собирает main.ts, тесты подставляют фейки).
 */

import { FileError, formatErrorLine, UsageError } from "./errors.ts";
import { renderGroupHelp } from "./help.ts";
import { type Subcommand, type XlsxIo } from "./command.ts";
import { lsCommand } from "./cmd_ls.ts";
import { getCommand } from "./cmd_get.ts";
import { openCommand } from "./cmd_open.ts";
import { resolveCommand } from "./cmd_resolve.ts";
import { aliasCommand } from "./cmd_alias.ts";

export type { XlsxIo } from "./command.ts";
// Часть контракта XlsxIo: реализация io обязана бросать этот класс.
export { NotFoundIoError } from "./errors.ts";
export { defaultConfigStorePath, makeDenoIo } from "./deno_io.ts";

/** Подкоманды в порядке показа в справке. */
const SUBCOMMANDS: readonly Subcommand[] = [
  lsCommand,
  getCommand,
  openCommand,
  resolveCommand,
  aliasCommand,
];

function groupHelpText(): string {
  return renderGroupHelp(
    "mpu xlsx <подкоманда> [аргументы]",
    "Чтение локальных .xlsx без сети: листы, значения диапазонов, " +
      "алиасы путей.",
    SUBCOMMANDS.map((sub) => ({ name: sub.name, summary: sub.help.summary })),
  );
}

/**
 * Точка входа команды: разбирает подкоманду, исполняет её и
 * возвращает exit-код; ошибки печатает в stderr сама.
 */
export async function runXlsx(
  args: readonly string[],
  io: XlsxIo,
): Promise<number> {
  try {
    return await dispatch(args, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${formatErrorLine(err)}\n`);
      return 2;
    }
    if (err instanceof FileError) {
      io.stderr(`${formatErrorLine(err)}\n`);
      return 1;
    }
    throw err;
  }
}

async function dispatch(
  args: readonly string[],
  io: XlsxIo,
): Promise<number> {
  const [first, ...rest] = args;
  if (first === undefined) {
    // Вызов без подкоманды: справка печатается, но это ошибка (спека).
    io.stdout(groupHelpText());
    return 2;
  }
  if (first === "-h" || first === "--help") {
    io.stdout(groupHelpText());
    return 0;
  }
  const sub = SUBCOMMANDS.find((s) => s.name === first);
  if (sub === undefined) {
    throw new UsageError(`unknown subcommand "${first}"`, {
      hint: "mpu xlsx --help",
    });
  }
  return await sub.run(rest, io);
}
