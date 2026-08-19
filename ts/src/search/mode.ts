/**
 * Выбор ветки команды `mpu search` (`docs/specs/search.md`,
 * «CLI-контракт»): локальный поиск по кэшу, email-ветка 10X или
 * 10X-резолв не-email селектора.
 *
 * Правило выражено чистой функцией и проверяется без кэша и без сети:
 * ветвление тут нетривиальное — email вместе с `--scope access` уходит
 * не в локальный режим и не в email-ветку, а в 10X-резолв селектора.
 */

/** Маска email — та же, что у предиката резолва (`platform/selector.md`). */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Значение `--scope`: закрытый список спеки. */
export type Scope = "auto" | "user" | "access";

/** Что команде известно о вызове к моменту выбора ветки. */
export interface ModeInputs {
  readonly value: string;
  readonly scope: Scope;
  /** `--reason` задан (значение по умолчанию сюда не считается). */
  readonly reasonGiven: boolean;
  readonly refreshCache: boolean;
}

/** Ветка вызова. */
export type SearchMode = "local" | "email" | "x10-selector";

/**
 * Ветка по правилу спеки, в объявленном ею порядке: email и `--scope`
 * не `access` → email-ветка; иначе любой из трёх признаков 10X
 * (`--reason`, `--refresh-cache`, `--scope` не `auto`) → 10X-резолв
 * селектора; иначе локальный режим.
 */
export function modeOf(inputs: ModeInputs): SearchMode {
  if (isEmail(inputs.value) && inputs.scope !== "access") return "email";
  if (
    inputs.reasonGiven || inputs.refreshCache || inputs.scope !== "auto"
  ) {
    return "x10-selector";
  }
  return "local";
}

/** Email ли селектор: та же маска, что выбирает email-предикат резолва. */
export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

/**
 * Эффективный scope 10X-резолва: `auto` → `access` для целого и полного
 * uuid кабинета, иначе `user` (спека, «10X-резолв не-email селектора»).
 */
export function effectiveScope(value: string, scope: Scope): Scope {
  if (scope !== "auto") return scope;
  return INTEGER.test(value) || UUID.test(value) ? "access" : "user";
}

const INTEGER = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
