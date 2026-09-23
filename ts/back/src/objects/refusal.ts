import type { RefusalData } from "../frames/mod.ts";
import { GRAMMAR, UNNAMED_REFUSAL } from "../messages/mod.ts";
import type { Hint, Refused, Remedy, Told } from "./protocol.ts";
import { nearest } from "./nearest.ts";
import { nearestOf, NO_HINT, NO_REMEDY } from "./remedy.ts";

/** Необязательное у отказа: причина, вид, подсказка и ближайшие. */
export interface RefusalOptions extends ErrorOptions {
  /** Подсказка по месту отказа; нет — подсказать нечего. */
  readonly remedy?: Remedy;
  /** Вид отказа — постоянная строка; не назван — «отказ». */
  readonly reason?: string;
  /** Ближайшие к непонятому; нет — пусто. */
  readonly candidates?: readonly string[];
}

/**
 * Объект отказывает ответить. Текст — без пути: путь до приёмника знает
 * только исполнитель цепочки, он и допишет его спереди, а за текстом —
 * подсказку по этому месту.
 */
export class Refusal extends Error {
  override name = "Refusal";
  readonly remedy: Remedy;
  readonly reason: string;
  readonly candidates: readonly string[];

  constructor(message: string, options: RefusalOptions = {}) {
    super(message, options);
    this.remedy = options.remedy ?? NO_REMEDY;
    this.reason = options.reason ?? UNNAMED_REFUSAL;
    this.candidates = options.candidates ?? [];
  }
}

/** Вид отказа прежнему имени (сообщения, ключа). */
export const RENAMED = "прежнее имя";

/** Вид отказа `doesNotUnderstand`. */
export const NOT_UNDERSTOOD = "не понимает";

/** Параметры отказа `doesNotUnderstand` без кандидатов. */
export const UNDERSTOOD_NOT: RefusalOptions = { reason: NOT_UNDERSTOOD };

/**
 * Отказ `doesNotUnderstand` с названными кандидатами: одна — подсказка
 * строкой с ней вместо непонятого слова.
 *
 * @param said начало текста (`не понимает kitn`, `данные не понимают …`)
 * @param selector непонятый селектор
 * @param label как назвать кандидатов в тексте: `ближайшие` или `есть`
 */
export function notUnderstood(
  said: string,
  selector: string,
  candidates: readonly string[],
  label: string,
): Refusal {
  const named = candidates.length > 0
    ? `; ${label}: ${candidates.join(", ")}`
    : "";
  return new Refusal(`${said}${named}${separated(selector)}`, {
    reason: NOT_UNDERSTOOD,
    candidates,
    remedy: nearestOf(selector, candidates),
  });
}

/**
 * Хвост отказа слову с приклеенным разделителем выражений (`title.`):
 * разделитель — отдельное слово (`platform/evaluator.md`, «Разбор»);
 * у прочих слов — пусто.
 */
export function separated(selector: string): string {
  const separator = GRAMMAR.separator;
  if (selector === separator || !selector.endsWith(separator)) return "";
  return `; ${separator} — отдельным словом`;
}

/**
 * Непонятый ключ ключевого сообщения: текст — прежний, без ближайших
 * (`не понимает idd:`), а объект отказа называет ближайшие ключи и, если
 * он один, строку с ним (`platform/refusal-object.md`).
 *
 * @param key непонятый ключ без двоеточия
 * @param known ключи, которые понимает получатель, без двоеточия
 */
export function unknownKey(
  said: string,
  key: string,
  known: readonly string[],
): Refusal {
  const close = nearest(key, known).map((name) => `${name}:`);
  return new Refusal(said, {
    reason: NOT_UNDERSTOOD,
    candidates: close,
    remedy: nearestOf(`${key}:`, close),
  });
}

/** Поля отказа строки. */
export interface RefusalFields {
  readonly reason: string;
  /** Текст без подсказки, с адресом спереди. */
  readonly said: string;
  readonly hint: Hint;
  readonly candidates: readonly string[];
}

/**
 * Отказ строки объектом: текст stderr — сказанное с хвостом подсказки;
 * объект границы — из тех же полей.
 */
export class RefusalNotice implements Refused {
  readonly #fields: RefusalFields;

  constructor(fields: RefusalFields) {
    this.#fields = fields;
  }

  text(): string {
    return `${this.#fields.said}${this.#fields.hint.said()}`;
  }

  data(): RefusalData {
    return {
      reason: this.#fields.reason,
      hint: this.#fields.hint.words(),
      candidates: [...this.#fields.candidates],
      text: this.text(),
    };
  }

  tell(to: Told) {
    to.refusal(this.data());
    to.stderr(`${this.text()}\n`);
  }
}

/** Отказ без подсказки и ближайших: вид и текст. */
export function plainRefusal(reason: string, text: string): Refused {
  return new RefusalNotice({
    reason,
    said: text,
    hint: NO_HINT,
    candidates: [],
  });
}

/** Строка не исполнилась: отказ для вызывающего. */
export class Rejection extends Error {
  override name = "Rejection";
  readonly refused: Refused;

  constructor(refused: Refused, options?: ErrorOptions) {
    super(refused.text(), options);
    this.refused = refused;
  }
}
