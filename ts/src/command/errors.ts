/**
 * Два класса ошибок контракта команды. Различаются типом, а не текстом
 * (`platform/command-contract.md`): отображение в exit-коды и коды HTTP —
 * забота точки входа, команда только называет класс.
 */

/** Что несёт ошибка команды сверх собственного текста. */
export interface ErrorDetails {
  /** Текст после «; попробуй:» в stderr; отсутствует — подсказки нет. */
  readonly hint?: string;
  /**
   * Подсказка дословно, без «попробуй:» — вторая её форма
   * (`docs/specs/kiten-time.md`, «Ввод/вывод»). Нужна там, где действий
   * несколько и надо выбрать: «останови `…` или сбрось `…`». «Попробуй»
   * перед выбором из двух команд обещает, что подойдёт любая.
   * Старше `hint`, если заданы обе.
   */
  readonly advice?: string;
  /**
   * Строки после строки ошибки, без завершающего перевода строки:
   * список кандидатов резолва (`platform/selector.md`). Готовит их тот,
   * кто знает предметную область, печатает — точка входа.
   */
  readonly details?: string;
  readonly cause?: unknown;
}

/** Ошибка ввода: аргументы не удовлетворяют схеме. */
export class UsageError extends Error {
  override name = "UsageError";
  readonly hint?: string;
  readonly advice?: string;
  readonly details?: string;

  constructor(message: string, opts?: ErrorDetails) {
    super(message, { cause: opts?.cause });
    this.hint = opts?.hint;
    this.advice = opts?.advice;
    this.details = opts?.details;
  }
}

/** Доменная ошибка: вход корректен, выполнить не удалось. */
export class DomainError extends Error {
  override name = "DomainError";
  readonly hint?: string;
  readonly advice?: string;
  readonly details?: string;

  constructor(message: string, opts?: ErrorDetails) {
    super(message, { cause: opts?.cause });
    this.hint = opts?.hint;
    this.advice = opts?.advice;
    this.details = opts?.details;
  }
}

/**
 * Доменная ошибка, чей текст печатается дословно, без префикса команды:
 * ответ внешней системы со своей формой. Единственный случай — текст
 * ошибки PostgreSQL (`specs/sql-ro.md`: `db error: <текст сервера>`,
 * многострочный, с позицией и указателем на место ошибки).
 */
export class VerbatimError extends DomainError {
  override name = "VerbatimError";
}

/**
 * Сообщение об ошибке для человека и агента:
 * `mpu <команда>: <причина>[; попробуй: <подсказка>][\n<подробности>]`.
 * У подсказки две формы, и обе — контракт: готовая команда после
 * «попробуй:» там, где действие одно, и дословный императив (`advice`)
 * там, где надо выбрать из нескольких.
 * Подробности — готовые строки от того, кто их собрал (список кандидатов
 * резолва); формат строки ошибки от их наличия не зависит. Имя в префиксе
 * объявляет сама команда (`Command.errorName`): у семейства `xlsx` спека
 * требует общего `mpu xlsx` на все подкоманды, у `kiten` — полного пути с
 * подкомандой. Формат общий для
 * обеих точек входа: в CLI строка уходит в stderr, в MCP — текстом
 * содержимого результата с признаком ошибки.
 */
export function formatCommandError(
  name: string,
  err: UsageError | DomainError,
): string {
  const hint = suggestion(err);
  const details = err.details === undefined ? "" : `\n${err.details}`;
  // Дословный текст внешней системы печатается без префикса: свою форму
  // он несёт сам (см. `VerbatimError`).
  const prefix = err instanceof VerbatimError ? "" : `mpu ${name}: `;
  return `${prefix}${err.message}${hint}${details}`;
}

/** Хвост подсказки: готовая команда, дословный императив либо ничего. */
function suggestion(err: UsageError | DomainError): string {
  if (err.advice !== undefined) return `; ${err.advice}`;
  return err.hint === undefined ? "" : `; попробуй: ${err.hint}`;
}

/**
 * Файл не найден при чтении через io: реализация io переводит ошибку
 * файловой системы в этот класс, чтобы команда различала «нет файла» и
 * прочие сбои без привязки к рантайму.
 */
export class NotFoundIoError extends Error {
  override name = "NotFoundIoError";
}
