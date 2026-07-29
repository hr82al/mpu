/**
 * Ошибки команды xlsx. Класс ошибки определяет exit-код (контракт
 * спеки xlsx.md): `UsageError` — ошибки ввода (exit 2), `FileError` —
 * ошибки файла и окружения (exit 1). Тексты, зафиксированные спекой,
 * передаются буквально, поэтому правило «с маленькой буквы, без точки»
 * к ним не применяется — наблюдаемая поверхность важнее стиля.
 */

/** Ошибка ввода пользователя: флаги, диапазоны, незаданный путь. Exit 2. */
export class UsageError extends Error {
  override name = "UsageError";
  /** Текст после «; попробуй:» в stderr; отсутствует — подсказки нет. */
  readonly hint?: string;

  constructor(message: string, opts?: { hint?: string; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.hint = opts?.hint;
  }
}

/** Ошибка файла или окружения: не найден, не zip, битый XML. Exit 1. */
export class FileError extends Error {
  override name = "FileError";
  /** Текст после «; попробуй:» в stderr; отсутствует — подсказки нет. */
  readonly hint?: string;

  constructor(message: string, opts?: { hint?: string; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.hint = opts?.hint;
  }
}

/**
 * Файл не найден при чтении через `XlsxIo`: реальная реализация io
 * переводит ошибку файловой системы в этот класс, чтобы логика команды
 * различала «нет файла» и прочие сбои без привязки к рантайму.
 */
export class NotFoundIoError extends Error {
  override name = "NotFoundIoError";
}

/**
 * Строка stderr по контракту спеки:
 * `mpu xlsx: <причина>[; попробуй: <подсказка>]`.
 */
export function formatErrorLine(err: UsageError | FileError): string {
  const hint = err.hint === undefined ? "" : `; попробуй: ${err.hint}`;
  return `mpu xlsx: ${err.message}${hint}`;
}
