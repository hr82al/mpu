/**
 * Получатель `ozon` — Ozon Seller API (`docs/specs/call.md`): хост,
 * заголовки квоты, ключ кабинета из `schema_<client>.ozon_api_keys` и два
 * сообщения — `call-ro` (реестр чтения) и `call` (запись через дверь
 * `ask`).
 */

import { defineCommand, record } from "../command/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { denoSession, type SqlSession } from "../sql/mod.ts";
import { type Access, ANY_REQUEST, ReadList } from "./access.ts";
import type { KeyRow } from "./key.ts";
import { READS } from "./reads.ts";
import {
  callExitCode,
  type CallOutcome,
  callRecord,
  renderCall,
  resultSchema,
} from "./reply.ts";
import {
  argsSchema,
  type CallArgs,
  type CallDeps,
  DEFAULT_TIMEOUT_S,
  type Marketplace,
  MAX_TIMEOUT_S,
  runCall,
} from "./run.ts";

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
  host: "api-seller.ozon.ru",
  usualMethod: "POST",
  emptyBody: "{}",
  quotaHeaders: ["ratelimit-remaining", "retry-after"],
  keys: async (session: SqlSession, clientId: number) => {
    const outcome = await session.query(keysQuery(clientId));
    if (outcome.kind !== "rows") return [];
    return outcome.rows.map(([cabinet, key]): KeyRow => ({
      cabinet: String(cabinet),
      key: String(key),
    }));
  },
};

/** Живое внешнее: сеть, часы, read-only сессия PG. */
const LIVE: CallDeps = {
  fetch: (request) => fetch(request),
  deadline: (ms) => AbortSignal.timeout(ms),
  now: () => performance.now(),
  openSession: denoSession("read-only"),
};

/** Общая часть справки обоих сообщений: ключи, вывод, коды. */
const KEYS_HELP =
  `target: — клиент: client_id, имя или часть (поиск по кэшу), dev:<client_id>.
Ключ кабинета берётся из БД клиента read-only сессией и наружу не выходит:
ни в вывод, ни в журнал, ни в текст отказа; эхо ключа в теле ответа
заменяется на ***.
cabinet: — Client-Id кабинета; у клиента один кабинет — можно опустить,
несколько — обязателен (отказ перечисляет Client-Id).
path: — путь ручки с /; хост — ${OZON_SELLER.host}.
body: — JSON-текст тела; без него POST шлёт {}. У GET тела нет.
method: — GET или POST. timeout: — секунды ожидания, 1…${MAX_TIMEOUT_S}, умолчание ${DEFAULT_TIMEOUT_S}.

Вывод: HTTP <статус> <метод> <хост><путь>, строки заголовков квоты
(${OZON_SELLER.quotaHeaders.join(", ")} — если присланы), пустая строка, тело
(JSON — с отступами). ${GRAMMAR.close} json — одна строка: status, method,
url, ms, headers, body. dry — запрос с api-key: *** без сети.
Один вызов — один запрос, повторов нет ни на 429, ни на 5xx; каждый вызов
тратит квоту кабинета клиента. В журнал вызовов тело ответа не пишется —
только статус, размер тела и заголовки квоты.

Exit: 0 — ответ 2xx и dry; 1 — ответ не 2xx, нет ответа за timeout:,
сетевой сбой; 2 — ошибка ввода и конфигурации: нет кабинета, несколько
кабинетов без cabinet:, body: не JSON, тело у GET, timeout: вне 1…${MAX_TIMEOUT_S}`;

const USAGE_KEYS = "target: КЛИЕНТ [cabinet: CLIENT-ID] path: ПУТЬ " +
  `[body: JSON] [method: GET|POST] [timeout: СЕК] [${GRAMMAR.close} json]`;

/** Одно сообщение получателя `ozon`: объявление над общим ходом вызова. */
function ozonCommand(declared: {
  readonly name: string;
  readonly policy: "ro" | "rw";
  readonly access: Access;
  readonly summary: string;
  readonly help: string;
  readonly examples: readonly string[];
}) {
  return defineCommand({
    path: ["ozon", declared.name],
    errorName: `ozon ${declared.name}`,
    summary: declared.summary,
    usage: `mpu ozon ${declared.name} [dry] ${USAGE_KEYS}`,
    help: `${declared.help}\n\n${KEYS_HELP}`,
    examples: declared.examples,
    keys: { target: "selector" },
    texts: ["path", "body"],
    policy: declared.policy,
    // Тело ответа — данные кабинета клиента: журнал хранит вызов,
    // статус и квоту (строкой note), но не сам ответ (спека [D.3]).
    logsStdout: false,
    argsSchema,
    resultSchema,
    run: async (args: CallArgs, io) => ({
      call: await runCall(args, io, LIVE, {
        marketplace: OZON_SELLER,
        access: declared.access,
      }),
    }),
    data: record((result: CallOutcome) => callRecord(result.call)),
    render: (result: CallOutcome) => renderCall(result.call),
    textExitCode: (result: CallOutcome) => callExitCode(result.call),
  });
}

export const ozonCallRoCommand = ozonCommand({
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

export const ozonCallCommand = ozonCommand({
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
