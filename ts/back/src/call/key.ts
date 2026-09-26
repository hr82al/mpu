/**
 * Ключ кабинета (`docs/specs/call.md`, «Пункты чек-листа» 5): значение
 * ключа — приватная память объекта. Наружу он отвечает только «покажи
 * авторизацию скрытой», «подпиши и отправь» и «замаскируй текст»; ни в
 * одном возвращаемом результате значения нет. Как подписать запрос,
 * решает ключ своего получателя.
 */

import { UsageError } from "../command/mod.ts";
import type { Received, Signed, Wire } from "./transport.ts";

/** Замена ключа в любом выводе. */
export const MASK = "***";

/** Ключ одного кабинета — протокол, реализация у получателя. */
export interface CabinetKey {
  /** Идентификатор кабинета: у Ozon — Client-Id Seller. */
  readonly cabinet: string;
  /** Заголовки авторизации для печати `dry`: секреты скрыты. */
  shown(): Record<string, string>;
  /**
   * Подписать запрос и отправить.
   *
   * @param request запрос без авторизации
   * @param wire отправка подписанного запроса
   */
  call(request: Signed, wire: Wire): Promise<Received>;
  /** Текст с каждым вхождением секрета, заменённым на `***`. */
  mask(text: string): string;
}

/** Ключ кабинета Ozon Seller: заголовки `client-id` и `api-key`. */
export class SellerKey implements CabinetKey {
  readonly cabinet: string;
  readonly #key: string;

  constructor(cabinet: string, key: string) {
    this.cabinet = cabinet;
    this.#key = key;
  }

  shown(): Record<string, string> {
    return { "client-id": this.cabinet, "api-key": MASK };
  }

  call(request: Signed, wire: Wire): Promise<Received> {
    const sign = { "client-id": this.cabinet, "api-key": this.#key };
    return wire({ ...request, headers: { ...sign, ...request.headers } });
  }

  mask(text: string): string {
    return this.#key === "" ? text : text.replaceAll(this.#key, MASK);
  }
}

/** Какой кабинет ищется и как назвать его в отказе. */
export interface Sought {
  /** `cabinet:` вызова; не задан — кабинет должен быть один. */
  readonly cabinet: string | undefined;
  /** Селектор клиента, как его назвал вызывающий. */
  readonly client: string;
  /** Имя маркетплейса в тексте отказа: `Ozon`. */
  readonly marketplace: string;
}

/**
 * Ключ кабинета среди ключей клиента: названный `cabinet:`, иначе
 * единственный. Список кабинетов в отказе — только идентификаторы.
 */
export function cabinetOf(
  keys: readonly CabinetKey[],
  sought: Sought,
): CabinetKey {
  const { cabinet, client, marketplace } = sought;
  if (cabinet !== undefined) {
    const key = keys.find((one) => one.cabinet === cabinet);
    if (key === undefined) {
      throw new UsageError(
        `у клиента ${client} нет кабинета ${marketplace} ${cabinet}`,
      );
    }
    return key;
  }
  if (keys.length === 1) return keys[0];
  if (keys.length === 0) {
    throw new UsageError(`у клиента ${client} нет кабинетов ${marketplace}`);
  }
  const ids = keys.map((key) => key.cabinet).join(" | ");
  throw new UsageError(
    `у клиента ${client} кабинетов ${marketplace} ${keys.length} — укажи cabinet: ${ids}`,
  );
}
