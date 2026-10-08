/**
 * Реестр чтения (`docs/specs/call.md`, «Конфигурация»): ручки, которые
 * `call-ro` вправе вызвать. Данные модуля, а не файл конфигурации: новая
 * ручка чтения — строка здесь и ревью.
 */

/** Метод запроса: других спека не принимает. */
export type Method = "GET" | "POST";

/** Сегмент правила, совпадающий с любым одним сегментом пути. */
const ANY_SEGMENT = "{}";

/** Строка реестра — правило «подходит ли запрос». */
export class ReadRule {
  readonly method: Method;
  readonly host: string;
  readonly #segments: readonly string[];

  private constructor(method: Method, host: string, segments: string[]) {
    this.method = method;
    this.host = host;
    this.#segments = segments;
  }

  /**
   * Строка `<МЕТОД> <хост><путь>`; пробелов между словами — сколько угодно.
   *
   * @throws Error — строка не той формы: реестр объявлен в коде, ошибка в
   *   нём — дефект модуля, а не ввод
   */
  static parse(line: string): ReadRule {
    const [method, address, ...rest] = line.trim().split(/\s+/);
    const slash = address?.indexOf("/") ?? -1;
    if ((method !== "GET" && method !== "POST") || slash < 1 || rest.length) {
      throw new Error(`строка реестра чтения не той формы: ${line}`);
    }
    return new ReadRule(
      method,
      address.slice(0, slash),
      address.slice(slash).split("/"),
    );
  }

  /** Та же ли ручка: хост и путь, метод не сравнивается. */
  names(host: string, path: string): boolean {
    if (host !== this.host) return false;
    const segments = path.split("/");
    return (
      segments.length === this.#segments.length &&
      this.#segments.every(
        (segment, i) => segment === ANY_SEGMENT || segment === segments[i],
      )
    );
  }

  /** Подходит ли запрос: метод, хост и путь. */
  matches(method: Method, host: string, path: string): boolean {
    return method === this.method && this.names(host, path);
  }
}

/** Посев реестра — дословно из спеки. */
const SEED = `
GET  api-seller.ozon.ru/v1/actions
POST api-seller.ozon.ru/v1/actions/products
POST api-seller.ozon.ru/v1/actions/candidates
POST api-seller.ozon.ru/v1/analytics/data
POST api-seller.ozon.ru/v1/analytics/product-queries/details
POST api-seller.ozon.ru/v1/analytics/stocks
POST api-seller.ozon.ru/v1/finance/accrual/by-day
POST api-seller.ozon.ru/v1/finance/accrual/types
POST api-seller.ozon.ru/v1/finance/cash-flow-statement/list
POST api-seller.ozon.ru/v1/finance/products/buyout
POST api-seller.ozon.ru/v3/posting/fbo/list
POST api-seller.ozon.ru/v3/posting/fbs/list
POST api-seller.ozon.ru/v1/product/action/timer/status
POST api-seller.ozon.ru/v4/product/info/attributes
POST api-seller.ozon.ru/v4/product/info/stocks
POST api-seller.ozon.ru/v3/product/list
POST api-seller.ozon.ru/v3/product/info/list
POST api-seller.ozon.ru/v1/report/postings/create
POST api-seller.ozon.ru/v1/report/info
POST api-seller.ozon.ru/v1/returns/list
POST api-seller.ozon.ru/v1/roles
POST api-seller.ozon.ru/v1/seller/info
GET  api-performance.ozon.ru/api/client/campaign
GET  api-performance.ozon.ru/api/client/statistics/daily/json
GET  api-performance.ozon.ru/api/client/statistics/report
GET  api-performance.ozon.ru/api/client/statistics/{}
GET  api-performance.ozon.ru/api/client/statistics/all_sku_promo/orders/generate/json
POST api-performance.ozon.ru/api/client/statistic/products/generate/json
POST api-performance.ozon.ru/api/client/statistics/json
GET  common-api.wildberries.ru/api/v1/seller-info
GET  statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod
`;

/** Реестр чтения всех получателей. */
export const READS: readonly ReadRule[] = SEED.trim()
  .split("\n")
  .map(ReadRule.parse);
