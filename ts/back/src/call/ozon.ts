/**
 * Получатель `ozon` — Ozon Seller API (`docs/specs/call.md`): хост,
 * заголовки квоты, ключ кабинета из `schema_<client>.ozon_api_keys` и два
 * сообщения — `call-ro` (реестр чтения) и `call` (запись через дверь
 * `ask`).
 */

import type { SqlSession } from "../sql/mod.ts";
import { ANY_REQUEST, ReadList } from "./access.ts";
import { FixedHost } from "./address.ts";
import { type CabinetKey, SellerKey } from "./key.ts";
import { callMessage, type Receiver } from "./message.ts";
import { READS } from "./reads.ts";
import type { Marketplace, Wanted } from "./run.ts";

/**
 * Строки с обоими полями кабинета. Порядка нет намеренно: список
 * кабинетов в отказе идёт порядком таблицы.
 */
function keysQuery(clientId: number): string {
  return "SELECT seller_client_id::text, seller_api_key " +
    `FROM "schema_${clientId}".ozon_api_keys ` +
    "WHERE seller_client_id IS NOT NULL AND seller_api_key IS NOT NULL " +
    "AND seller_api_key <> ''";
}

/** Ozon Seller глазами вызова. */
export const OZON_SELLER: Marketplace = {
  path: ["ozon"],
  name: "Ozon",
  address: new FixedHost("api-seller.ozon.ru"),
  usualMethod: () => "POST",
  emptyBody: "{}",
  quotaHeaders: ["ratelimit-remaining", "retry-after"],
  keys: async (session: SqlSession, { clientId }: Wanted) => {
    const outcome = await session.query(keysQuery(clientId));
    if (outcome.kind !== "rows") return [];
    return outcome.rows.map(([cabinet, key]): CabinetKey =>
      new SellerKey(String(cabinet), String(key))
    );
  },
};

/** Ozon Seller глазами справки. */
const SELLER: Receiver = {
  marketplace: OZON_SELLER,
  help: {
    cabinetId: "Client-Id",
    key:
      `Ключ кабинета берётся из БД клиента read-only сессией и наружу не выходит:
ни в вывод, ни в журнал, ни в текст отказа; эхо ключа в теле ответа
заменяется на ***.`,
    body: "body: — JSON-текст тела; без него POST шлёт {}. У GET тела нет.",
    requests: "Один вызов — один запрос",
    dry: "api-key: ***",
    refusals: "",
  },
};

export const ozonCallRoCommand = callMessage(SELLER, {
  name: "call-ro",
  policy: "ro",
  access: new ReadList(READS),
  summary:
    "что сейчас отвечает ручка чтения Ozon Seller API под ключом кабинета клиента",
  help: `Звать, когда нужен живой ответ Ozon Seller API по кабинету клиента:
что отдаёт ручка, сколько осталось квоты, какой retry-after. Ключ
кабинета подставляет mpu из БД клиента — в руки его брать не нужно, и
разовый скрипт с чтением ключа не нужен. Только ручки из списка чтения;
прочие — отказ до чтения ключа с готовой строкой mpu ask ozon call.`,
  examples: [
    "mpu ozon call-ro target: 54 path: /v1/seller/info",
    'mpu ozon call-ro target: 54 cabinet: 2129958 path: /v1/finance/products/buyout body: {"date_from":"2026-09-10","date_to":"2026-09-10"}',
    `mpu ozon call-ro dry target: 54 path: /v1/seller/info`,
  ],
});

export const ozonCallCommand = callMessage(SELLER, {
  name: "call",
  policy: "rw",
  access: ANY_REQUEST,
  summary:
    "вызвать любую ручку Ozon Seller API под ключом кабинета клиента (запись)",
  help: `Звать, когда ручка меняет данные кабинета у Ozon или её нет в списке
чтения mpu ozon call-ro. Идёт только через дверь ask: вызов с
подтверждением человека. Изменение, которое делает ручка, — у Ozon, и
отменить его mpu не может.`,
  examples: [
    'mpu ask ozon call target: 54 path: /v1/product/import body: {"items":[]}',
  ],
});

/** Сообщения получателя `ozon`. */
export const ozonCommands = [ozonCallRoCommand, ozonCallCommand];
