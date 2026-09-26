/**
 * Ключ кабинета (`docs/specs/call.md`, «Пункты чек-листа» 5): значение
 * ключа — приватная память объекта. Наружу он отвечает только «подписать
 * запрос» и «замаскировать текст»; ни в одном возвращаемом результате
 * значения нет.
 */

import { UsageError } from "../command/mod.ts";

/** Замена ключа в любом выводе. */
export const MASK = "***";

/** Строка ключей кабинета, как её отдала БД клиента. */
export interface KeyRow {
  readonly cabinet: string;
  readonly key: string;
}

/** Ключ одного кабинета. */
export class CabinetKey {
  /** Идентификатор кабинета: у Ozon Seller — Client-Id. */
  readonly cabinet: string;
  readonly #key: string;

  constructor(row: KeyRow) {
    this.cabinet = row.cabinet;
    this.#key = row.key;
  }

  /** Заголовки авторизации запроса Ozon Seller. */
  sign(): Record<string, string> {
    return { "client-id": this.cabinet, "api-key": this.#key };
  }

  /** Те же заголовки для печати: ключ скрыт. */
  shown(): Record<string, string> {
    return { "client-id": this.cabinet, "api-key": MASK };
  }

  /** Текст с каждым вхождением ключа, заменённым на `***`. */
  mask(text: string): string {
    return this.#key === "" ? text : text.replaceAll(this.#key, MASK);
  }
}

/**
 * Ключ кабинета из строк клиента: названный `cabinet:`, иначе
 * единственный. Список кабинетов в отказе — только идентификаторы.
 *
 * @param cabinet `cabinet:` вызова; не задан — кабинет должен быть один
 * @param client селектор клиента, как его назвал вызывающий
 */
export function cabinetOf(
  rows: readonly KeyRow[],
  cabinet: string | undefined,
  client: string,
): CabinetKey {
  if (cabinet !== undefined) {
    const row = rows.find((one) => one.cabinet === cabinet);
    if (row === undefined) {
      throw new UsageError(`у клиента ${client} нет кабинета Ozon ${cabinet}`);
    }
    return new CabinetKey(row);
  }
  if (rows.length === 1) return new CabinetKey(rows[0]);
  if (rows.length === 0) {
    throw new UsageError(`у клиента ${client} нет кабинетов Ozon`);
  }
  const ids = rows.map((row) => row.cabinet).join(" | ");
  throw new UsageError(
    `у клиента ${client} кабинетов Ozon ${rows.length} — укажи cabinet: ${ids}`,
  );
}
