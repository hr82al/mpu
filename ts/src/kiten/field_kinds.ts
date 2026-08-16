/**
 * Скалярные кастомные поля карточки: закрытый список видов и таблица
 * «вид → id поля инстанса» (`docs/specs/kiten-field.md`, «CLI-контракт»).
 *
 * Отдельно от команды `field`, потому что тем же механизмом записи полей
 * пользуется `close` (`docs/specs/kiten-close.md`): таблица одна на обе
 * команды, и вторая её копия разошлась бы с первой на первом же
 * переименованном поле.
 */

/** Скалярные поля карточки; закрытый список — контракт CLI. */
export const FIELD_KINDS = ["mr", "hypothesis", "done", "result"] as const;

/** Вид поля — `FieldKind` глоссария. */
export type FieldKind = typeof FIELD_KINDS[number];

/** Вид поля → id кастомного поля инстанса Kaiten (таблица спеки). */
export const PROPERTY_IDS: Readonly<Record<FieldKind, number>> = {
  mr: 398965,
  hypothesis: 291984,
  done: 291985,
  result: 291990,
};

/** Ключ поля в теле запроса и в `properties` ответа карточки. */
export function propertyKey(kind: FieldKind): string {
  return `id_${PROPERTY_IDS[kind]}`;
}
