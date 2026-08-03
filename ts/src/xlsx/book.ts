/**
 * Открытие книги для команд `xlsx`: чтение файла и разбор OOXML с
 * переводом ошибок нижних слоёв в доменные с текстами спеки.
 */

import {
  type CommandIo,
  DomainError,
  NotFoundIoError,
} from "../command/mod.ts";
import { parseWorkbook, type Workbook, WorkbookError } from "./workbook.ts";

/** Читает и разбирает книгу; ошибки — `DomainError` с текстами спеки. */
export async function loadWorkbook(
  io: CommandIo,
  path: string,
): Promise<Workbook> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(path);
  } catch (err) {
    if (err instanceof NotFoundIoError) {
      throw new DomainError(`file not found: "${path}"`, { cause: err });
    }
    throw new DomainError(`cannot read "${path}"`, { cause: err });
  }
  try {
    return await parseWorkbook(bytes);
  } catch (err) {
    if (err instanceof WorkbookError) {
      throw new DomainError(
        `not a valid xlsx file: "${path}" (${err.message})`,
        { cause: err },
      );
    }
    throw err;
  }
}
