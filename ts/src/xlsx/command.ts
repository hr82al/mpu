/**
 * Каркас подкоманд xlsx: интерфейс io-зависимостей, тип подкоманды и
 * общие шаги (хранилище конфига, резолв пути, открытие книги) с
 * переводом ошибок нижних слоёв в UsageError/FileError команды.
 */

import type { SubcommandHelp } from "./help.ts";
import { FileError, NotFoundIoError } from "./errors.ts";
import {
  parseStore,
  serializeStore,
  type StoreData,
  StoreFormatError,
} from "../config/mod.ts";
import { type ResolveReport, resolveXlsxPath } from "./resolve.ts";
import { parseWorkbook, type Workbook, WorkbookError } from "./workbook.ts";

/**
 * Внешние зависимости команды. Реализацию собирает main.ts; тесты
 * подставляют фейки (вывод — в буфер, окружение — словарь).
 */
export interface XlsxIo {
  readonly env: (name: string) => string | undefined;
  readonly cwd: () => string;
  /** Байты файла; отсутствие файла — `NotFoundIoError`. */
  readonly readFile: (path: string) => Promise<Uint8Array>;
  /** Текст файла; отсутствие файла — `NotFoundIoError`. */
  readonly readTextFile: (path: string) => Promise<string>;
  readonly readTextStdin: () => Promise<string>;
  /** Содержимое файла хранилища; файла нет — `undefined`. */
  readonly readConfigStore: () => Promise<string | undefined>;
  /** Запись хранилища: каталог создаётся, права файла 0600. */
  readonly writeConfigStore: (text: string) => Promise<void>;
  /** Запуск открывателя отвязанно; нет бинаря — `false`. */
  readonly launchOpener: (cmd: string, target: string) => boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Подкоманда: без имени, однострочки и листовой справки не собирается. */
export interface Subcommand {
  readonly name: string;
  readonly help: SubcommandHelp;
  readonly run: (args: readonly string[], io: XlsxIo) => Promise<number>;
}

/** Хранилище конфига; битый файл — инфраструктурная ошибка (exit 1). */
export async function loadStore(io: XlsxIo): Promise<StoreData> {
  const raw = await io.readConfigStore();
  try {
    return parseStore(raw);
  } catch (err) {
    if (err instanceof StoreFormatError) {
      throw new FileError(`corrupt config store (${err.message})`, {
        cause: err,
      });
    }
    throw err;
  }
}

/** Сериализует и пишет хранилище (каталог и права 0600 — io-слой). */
export async function saveStore(io: XlsxIo, data: StoreData): Promise<void> {
  await io.writeConfigStore(serializeStore(data));
}

/** Резолв пути по трём источникам спеки (для команд с файлом). */
export async function resolvePath(
  io: XlsxIo,
  flagValue: string | undefined,
): Promise<ResolveReport> {
  const store = await loadStore(io);
  return resolveXlsxPath({
    flagValue,
    envValue: io.env("MPU_XLSX"),
    configValue: store.values["xlsx.default"],
    aliasPath: (name) => store.aliases[name],
    cwd: io.cwd(),
    home: io.env("HOME"),
  });
}

/** Читает и разбирает книгу; ошибки — `FileError` с текстами спеки. */
export async function loadWorkbook(
  io: XlsxIo,
  path: string,
): Promise<Workbook> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(path);
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      throw new FileError(`file not found: "${path}"`, { cause: err });
    }
    throw new FileError(`cannot read "${path}"`, { cause: err });
  }
  try {
    return await parseWorkbook(bytes);
  } catch (err) {
    if (err instanceof WorkbookError) {
      throw new FileError(`not a valid xlsx file: "${path}" (${err.message})`, {
        cause: err,
      });
    }
    throw err;
  }
}
