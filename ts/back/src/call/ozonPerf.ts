/**
 * Получатель `ozon perf` — Ozon Performance API (`docs/specs/call.md`):
 * другой хост и авторизация OAuth `client_credentials`. Ключи —
 * `performance_client_id` и `performance_client_secret` кабинета из
 * `schema_<client>.ozon_api_keys`; на каждый вызов — обмен на bearer
 * (исполнитель строк не держит состояния между строками, решение хоста
 * 2026-09-26), сам токен — приватная память ключа на время строки.
 */

import { DomainError, UsageError } from "../command/mod.ts";
import type { SqlSession } from "../sql/mod.ts";
import { ANY_REQUEST, ReadList } from "./access.ts";
import { FixedHost } from "./address.ts";
import { type CabinetKey, MASK } from "./key.ts";
import { callMessage, LIVE, type Receiver } from "./message.ts";
import { READS } from "./reads.ts";
import { succeeded } from "./reply.ts";
import type { Marketplace, Wanted } from "./run.ts";
import type { Received, Signed, Wire } from "./transport.ts";

const HOST = "api-performance.ozon.ru";

/** Ручка обмена `client_credentials` на bearer. */
const TOKEN_URL = `https://${HOST}/api/client/token`;

/** Ключи Performance кабинета. */
interface Credentials {
  readonly id: string;
  readonly secret: string;
}

/** Выданное обменом: подписывает запрос либо само и есть ответ. */
interface Grant {
  call(request: Signed, wire: Wire): Promise<Received>;
  mask(text: string): string;
}

/** Bearer, выданный обменом. */
class Bearer implements Grant {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  call(request: Signed, wire: Wire): Promise<Received> {
    const sign = { authorization: `Bearer ${this.#token}` };
    return wire({ ...request, headers: { ...sign, ...request.headers } });
  }

  mask(text: string): string {
    return text.replaceAll(this.#token, MASK);
  }
}

/**
 * Обмен ответил не 2xx: его ответ и есть результат вызова (спека,
 * «Граничные случаи»: статус и тело обмена, код 1), запрос не уходит.
 */
class Refused implements Grant {
  readonly #reply: Received;

  constructor(reply: Received) {
    this.#reply = reply;
  }

  call(): Promise<Received> {
    return Promise.resolve(this.#reply);
  }

  mask(text: string): string {
    return text;
  }
}

/** Обмена ещё не было: скрывать нечего. */
const NOT_GRANTED: Grant = {
  call: () => Promise.reject(new Error("запрос до обмена токена")),
  mask: (text) => text,
};

/**
 * Где взять bearer — порт получателя: сейчас обмен на каждый вызов, память
 * токена у ядра позже станет другой реализацией.
 */
export interface Tokens {
  grant(credentials: Credentials, wire: Wire): Promise<Grant>;
}

/** Обмен на каждый вызов: токен живёт одну строку. */
export const EXCHANGE_EACH_CALL: Tokens = {
  grant: async (credentials, wire) => {
    const reply = await wire({
      method: "POST",
      url: TOKEN_URL,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: credentials.id,
        client_secret: credentials.secret,
        grant_type: "client_credentials",
      }),
    });
    if (!succeeded(reply.status)) return new Refused(reply);
    return new Bearer(accessTokenOf(reply.text));
  },
};

/**
 * `access_token` ответа обмена. Нет его — сбой без тела ответа в тексте:
 * токен мог прийти под другим именем.
 */
function accessTokenOf(text: string): string {
  let token: unknown;
  try {
    token = (JSON.parse(text) as { access_token?: unknown }).access_token;
  } catch {
    // Не JSON — тот же исход, что и JSON без токена, ниже.
  }
  if (typeof token === "string" && token !== "") return token;
  throw new DomainError("обмен токена: в ответе нет access_token");
}

/** Ключ кабинета Ozon Performance: bearer обменом перед запросом. */
class PerfKey implements CabinetKey {
  readonly cabinet: string;
  readonly #credentials: Credentials;
  readonly #tokens: Tokens;
  #grant: Grant = NOT_GRANTED;

  constructor(cabinet: string, credentials: Credentials, tokens: Tokens) {
    this.cabinet = cabinet;
    this.#credentials = credentials;
    this.#tokens = tokens;
  }

  shown(): Record<string, string> {
    return { authorization: `Bearer ${MASK}` };
  }

  async call(request: Signed, wire: Wire): Promise<Received> {
    this.#grant = await this.#tokens.grant(this.#credentials, wire);
    return this.#grant.call(request, wire);
  }

  mask(text: string): string {
    return this.#grant.mask(text.replaceAll(this.#credentials.secret, MASK));
  }
}

/** Кабинет без ключей Performance: отказ до сети, и у `dry` тоже. */
class MissingPerfKey implements CabinetKey {
  readonly cabinet: string;

  constructor(cabinet: string) {
    this.cabinet = cabinet;
  }

  shown(): Record<string, string> {
    throw this.#refusal();
  }

  call(): Promise<Received> {
    return Promise.reject(this.#refusal());
  }

  mask(text: string): string {
    return text;
  }

  #refusal(): UsageError {
    return new UsageError(
      `у кабинета ${this.cabinet} нет ключей Performance API`,
    );
  }
}

/**
 * Все кабинеты клиента: кабинет без ключей Performance остаётся в списке,
 * чтобы отказ назвал его, а не «нет кабинета».
 */
function keysQuery(clientId: number): string {
  return (
    "SELECT seller_client_id::text, performance_client_id, " +
    `performance_client_secret FROM "schema_${clientId}".ozon_api_keys ` +
    "WHERE seller_client_id IS NOT NULL"
  );
}

/** Ключ кабинета из строки: оба поля Performance заданы — иначе отказ. */
function keyOf(row: readonly unknown[], tokens: Tokens): CabinetKey {
  const [cabinet, id, secret] = row.map((cell) => String(cell ?? ""));
  if (id === "" || secret === "") return new MissingPerfKey(cabinet);
  return new PerfKey(cabinet, { id, secret }, tokens);
}

/**
 * Ozon Performance глазами вызова.
 *
 * @param tokens где взять bearer
 */
export function ozonPerf(tokens: Tokens): Marketplace {
  return {
    path: ["ozon", "perf"],
    name: "Ozon",
    address: new FixedHost(HOST),
    usualMethod: (body) => (body === undefined ? "GET" : "POST"),
    emptyBody: null,
    quotaHeaders: ["ratelimit-remaining", "retry-after"],
    keys: async (session: SqlSession, { clientId }: Wanted) => {
      const outcome = await session.query(keysQuery(clientId));
      if (outcome.kind !== "rows") return [];
      return outcome.rows.map((row) => keyOf(row, tokens));
    },
  };
}

const PERF: Receiver = {
  marketplace: ozonPerf(EXCHANGE_EACH_CALL),
  help: {
    cabinetId: "Client-Id",
    key: `Ключи Performance кабинета берутся из БД клиента read-only сессией и на
каждый вызов меняются на bearer (POST ${TOKEN_URL} —
ещё один запрос). Ни секрет, ни bearer наружу не выходят: ни в вывод, ни
в журнал, ни в текст отказа; эхо в теле ответа заменяется на ***. Обмен
ответил не 2xx — его статус и тело и есть результат.`,
    body: "body: — JSON-текст тела; с ним метод по умолчанию POST, без него — GET.",
    requests: "Один вызов — обмен токена и один запрос",
    dry: "authorization: Bearer ***, без обмена токена и",
    refusals: "у кабинета нет ключей Performance, ",
  },
};

export const ozonPerfCallRoCommand = callMessage(
  PERF,
  {
    name: "call-ro",
    policy: "ro",
    access: new ReadList(READS),
    summary:
      "что сейчас отвечает ручка чтения Ozon Performance API (реклама) под ключами кабинета клиента",
    help: `Звать, когда нужен живой ответ рекламного API Ozon (Performance) по
кабинету клиента: кампании, статистика, заказ отчёта. Ключи и обмен на
bearer делает mpu — секрет в руки брать не нужно. Только ручки из списка
чтения; прочие — отказ до чтения ключа с готовой строкой mpu ask ozon perf
call.`,
    examples: [
      "mpu ozon perf call-ro target: 54 path: /api/client/campaign",
      'mpu ozon perf call-ro target: 54 path: /api/client/statistics/json body: {"campaigns":["1"]}',
      "mpu ozon perf call-ro dry target: 54 path: /api/client/campaign",
    ],
  },
  LIVE,
);

export const ozonPerfCallCommand = callMessage(
  PERF,
  {
    name: "call",
    policy: "rw",
    access: ANY_REQUEST,
    summary:
      "вызвать любую ручку Ozon Performance API (реклама) под ключами кабинета клиента (запись)",
    help: `Звать, когда ручка меняет рекламу кабинета у Ozon (кампании, ставки)
или её нет в списке чтения mpu ozon perf call-ro. Идёт только через дверь
ask: вызов с подтверждением человека. Изменение, которое делает ручка, — у
Ozon, и отменить его mpu не может.`,
    examples: [
      "mpu ask ozon perf call target: 54 path: /api/client/campaign/1/activate method: POST",
    ],
  },
  LIVE,
);

/** Сообщения получателя `ozon perf`. */
export const ozonPerfCommands = [ozonPerfCallRoCommand, ozonPerfCallCommand];
