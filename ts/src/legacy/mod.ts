/**
 * Маршрут `legacy` (`platform/registry.md`): команда исполняется
 * подпроцессом установленной Python-реализации, а реестр в её вывод не
 * вмешивается — stdout, stderr и код возврата проходят насквозь.
 *
 * Контракту команды такая запись не подчиняется и подчиняться не может:
 * ни схемы результата, ни рендера у подпроцесса нет. Поэтому здесь не
 * `Command`, а запись реестра из двух полей: имени и однострокѝ.
 */

import {
  type CommandIo,
  DomainError,
  NotFoundIoError,
} from "../command/mod.ts";
import { parseStore } from "../config/mod.ts";

/** Срез порта для поиска пути к реализации: ключ конфига и HOME. */
type LegacyBinIo = Pick<CommandIo, "env" | "readConfigStore">;

/** Срез порта, который потребляет маршрут: путь плюс запуск подпроцесса. */
type LegacyIo = LegacyBinIo & Pick<CommandIo, "runLegacy">;

/** Запись реестра маршрута `legacy`. */
export interface LegacyCommand {
  /** Сегменты имени после `mpu`. */
  readonly path: readonly string[];
  /** Назначение: одна строка для индекса родителя. */
  readonly summary: string;
}

/** Ключ конфига с путём к Python-реализации (`platform/config.md`). */
const LEGACY_BIN_KEY = "mcp.legacy_bin";

/** Путь по умолчанию — установка через uv tool (`platform/config.md`). */
export const DEFAULT_LEGACY_BIN = "~/.local/share/uv/tools/mpu/bin/mpu";

/** Приёмник вывода подпроцесса; шире этого маршруту ничего не нужно. */
export interface LegacySink {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Исполняет команду подпроцессом и возвращает его код возврата.
 * Аргументы уходят как есть, включая незнакомые реестру: разбирает их
 * сама реализация, а не CLI.
 */
export async function runLegacyCommand(
  command: LegacyCommand,
  args: readonly string[],
  io: LegacyIo,
  output: LegacySink,
): Promise<number> {
  const bin = await resolveLegacyBin(io);
  const argv = [...command.path, ...args];
  let outcome;
  try {
    outcome = await io.runLegacy(bin, argv);
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      // Текст спеки, префикс `mpu:` — сообщение самого реестра, а не
      // команды: до команды дело не дошло.
      throw new LegacyBinMissingError(
        `legacy-реализация не найдена по пути "${bin}"`,
        { cause: err },
      );
    }
    throw err;
  }
  // Вывод переносится дословно: ни переупаковки, ни добавленных
  // переводов строки — вызывающие полагаются на побайтное совпадение
  // с прямым вызовом Python-версии.
  if (outcome.stdout !== "") output.stdout(outcome.stdout);
  if (outcome.stderr !== "") output.stderr(outcome.stderr);
  return outcome.code;
}

/**
 * Подпроцесс не запустился: файла по пути нет или он не исполняем.
 * Отдельный класс, потому что сообщение печатается без имени команды.
 */
export class LegacyBinMissingError extends DomainError {
  override name = "LegacyBinMissingError";
}

/** Путь к реализации: ключ конфига, иначе умолчание спеки. */
export async function resolveLegacyBin(io: LegacyBinIo): Promise<string> {
  const store = parseStore(await io.readConfigStore());
  return legacyBinPath(store.values[LEGACY_BIN_KEY], io.env("HOME"));
}

/** Раскрывает «~» в начале пути; HOME неизвестен — путь как есть. */
export function legacyBinPath(
  configured: string | undefined,
  home: string | undefined,
): string {
  const path = configured === undefined || configured === ""
    ? DEFAULT_LEGACY_BIN
    : configured;
  if (home === undefined || home === "") return path;
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}
