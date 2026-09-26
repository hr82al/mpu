/**
 * Получатель `wb` — Wildberries API (`docs/specs/call.md`): ключ адреса
 * `url:`, хост — из таблицы хостов WB, она же называет категорию токена.
 * Токен кабинета — из `public.wb_tokens` сервера клиента; какой из годных
 * взять (с `read_only` или без), решает предпочтение сообщения.
 */

import { UsageError } from "../command/mod.ts";
import type { SqlSession } from "../sql/mod.ts";
import { ANY_REQUEST, ReadList } from "./access.ts";
import type { Address, Aim } from "./address.ts";
import { type CallArgs, urlArgs } from "./args.ts";
import { type CabinetKey, MASK } from "./key.ts";
import { callMessage, type Receiver } from "./message.ts";
import { READS } from "./reads.ts";
import type { Marketplace, Wanted } from "./run.ts";
import type { Received, Signed, Wire } from "./transport.ts";

/** Категория токена WB — колонка `public.wb_tokens`. */
type Category =
  | "content"
  | "statistics"
  | "finance"
  | "analytics"
  | "adverts"
  | "marketplace"
  | "prices"
  | "supplies"
  | "questions"
  | "documents";

/** Какой токен годится хосту. */
interface Need {
  /** Выражение SQL: подходит ли строка токена. */
  readonly fits: string;
  /** Хвост отказа «нет действующего токена…». */
  readonly wanted: string;
  /** Как назвать в справке. */
  readonly named: string;
}

function categoryNeed(category: Category): Need {
  return {
    fits: `"${category}"`,
    wanted: ` категории ${category}`,
    named: category,
  };
}

/** `common-api`: годится токен любой категории. */
const ANY_CATEGORY: Need = { fits: "true", wanted: "", named: "любая" };

/**
 * Таблица хостов WB → категория токена — единственный источник для
 * проверки `url:`, выбора токена и справки (спека, «Пункты чек-листа»,
 * design-mpu 4).
 */
const HOSTS: ReadonlyMap<string, Need> = new Map([
  ["content-api.wildberries.ru", categoryNeed("content")],
  ["statistics-api.wildberries.ru", categoryNeed("statistics")],
  ["finance-api.wildberries.ru", categoryNeed("finance")],
  ["seller-analytics-api.wildberries.ru", categoryNeed("analytics")],
  ["advert-api.wildberries.ru", categoryNeed("adverts")],
  ["marketplace-api.wildberries.ru", categoryNeed("marketplace")],
  ["discounts-prices-api.wildberries.ru", categoryNeed("prices")],
  ["supplies-api.wildberries.ru", categoryNeed("supplies")],
  ["feedbacks-api.wildberries.ru", categoryNeed("questions")],
  ["documents-api.wildberries.ru", categoryNeed("documents")],
  ["common-api.wildberries.ru", ANY_CATEGORY],
]);

/** Потребность хоста; хост вне таблицы — отказ ввода (W5). */
function needOf(host: string): Need {
  const need = HOSTS.get(host);
  if (need !== undefined) return need;
  throw new UsageError(`хост ${host} не из API Wildberries`);
}

/** `url:` — полный адрес, хост из таблицы; иначе отказ до чтения ключа. */
const WB_URL: Address = {
  key: "url",
  argsSchema: urlArgs,
  usage: "url: АДРЕС",
  help: "url: — полный адрес https://<хост><путь>[?запрос]; хост и категория " +
    "токена:\n" +
    [...HOSTS].map(([host, need]) => `  ${host} — ${need.named}`).join("\n"),
  aim(args: CallArgs): Aim {
    // Схема `urlArgs` требует `url:`; тип общий для обоих адресов.
    const given = args.url ?? "";
    const url = URL.parse(given);
    if (url === null) throw new UsageError(`url: не адрес — ${given}`);
    if (url.protocol !== "https:") {
      throw new UsageError(`url: только https://, получено ${given}`);
    }
    needOf(url.host);
    return {
      host: url.host,
      path: url.pathname,
      url: url.href,
      named: `${url.host}${url.pathname}`,
    };
  },
};

/**
 * Годен ли токен — литерал отбора загрузчика (спека, «Побочные эффекты»):
 * действителен, не истёк, доступ `acc` загрузчику открыт.
 */
const USABLE = "is_valid = true AND (exp IS NULL OR exp > now()) AND " +
  "(acc IS NULL OR acc NOT IN (2, 3, 4) OR " +
  `(acc = 4 AND "for" = 'asid:932c176a-5085-5c6f-bc33-4e84cdf58d7e'))`;

/**
 * Все токены клиента: кабинет с одними негодными токенами остаётся в
 * списке, чтобы отказ сказал «нет действующего токена», а не «нет
 * кабинета» (решение хоста 2026-09-26).
 */
export function tokensQuery(host: string): string {
  const need = needOf(host);
  return "SELECT sid::text, token, read_only, " +
    `(${USABLE}) AS usable, ${need.fits} AS fits ` +
    "FROM public.wb_tokens WHERE client_id = $1 ORDER BY sid::text";
}

/** Годный токен кабинета глазами выбора. */
interface Token {
  readonly value: string;
  readonly readOnly: boolean;
}

/** Какой из годных токенов кабинета взять. */
export interface Preference {
  choose(tokens: readonly Token[]): Token | undefined;
}

/** `call-ro`: с `read_only`, если есть, — запись запрещает сам WB. */
export const READ_ONLY_FIRST: Preference = {
  choose: (tokens) => tokens.find((one) => one.readOnly) ?? tokens[0],
};

/** `call`: без `read_only`, если есть. */
export const WRITABLE_FIRST: Preference = {
  choose: (tokens) => tokens.find((one) => !one.readOnly) ?? tokens[0],
};

/**
 * Необязательные заголовки `sl-back`, заданные в env-файле: секретные
 * (`x-client-secret`) скрываются, открытые (`user-agent`) — нет.
 */
interface Extras {
  readonly secret: Readonly<Record<string, string>>;
  readonly open: Readonly<Record<string, string>>;
}

/** Ключ кабинета WB: токен в `authorization` как есть, без `Bearer`. */
class WbKey implements CabinetKey {
  readonly cabinet: string;
  readonly #token: string;
  readonly #extras: Extras;

  constructor(cabinet: string, token: string, extras: Extras) {
    this.cabinet = cabinet;
    this.#token = token;
    this.#extras = extras;
  }

  shown(): Record<string, string> {
    const hidden = Object.keys(this.#extras.secret).map((name) => [name, MASK]);
    return {
      authorization: MASK,
      ...Object.fromEntries(hidden),
      ...this.#extras.open,
    };
  }

  call(request: Signed, wire: Wire): Promise<Received> {
    const { secret, open } = this.#extras;
    const sign = { authorization: this.#token, ...secret, ...open };
    return wire({ ...request, headers: { ...sign, ...request.headers } });
  }

  mask(text: string): string {
    const secrets = [this.#token, ...Object.values(this.#extras.secret)];
    return secrets.reduce((masked, one) => masked.replaceAll(one, MASK), text);
  }
}

/** Кабинет без годного токена нужной категории: отказ до сети и у `dry`. */
class MissingToken implements CabinetKey {
  readonly cabinet: string;
  readonly #wanted: string;

  constructor(cabinet: string, wanted: string) {
    this.cabinet = cabinet;
    this.#wanted = wanted;
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
      `у кабинета ${this.cabinet} нет действующего токена${this.#wanted}`,
    );
  }
}

/** Годные токены по кабинетам — в порядке строк запроса. */
function tokensBySid(
  rows: readonly (readonly unknown[])[],
): Map<string, Token[]> {
  const bySid = new Map<string, Token[]>();
  for (const [sid, token, readOnly, usable, fits] of rows) {
    const tokens = bySid.get(String(sid)) ?? [];
    bySid.set(String(sid), tokens);
    if (usable !== true || fits !== true) continue;
    tokens.push({ value: String(token), readOnly: readOnly === true });
  }
  return bySid;
}

/** Заголовок из env-файла: не задан или пуст — заголовка нет. */
function headerOf(
  name: string,
  value: string | undefined,
): Record<string, string> {
  return value === undefined || value === "" ? {} : { [name]: value };
}

/**
 * Wildberries глазами вызова.
 *
 * @param preference какой из годных токенов кабинета взять
 */
export function wb(preference: Preference): Marketplace {
  return {
    path: ["wb"],
    name: "WB",
    address: WB_URL,
    usualMethod: (body) => body === undefined ? "GET" : "POST",
    emptyBody: null,
    quotaHeaders: [
      "x-ratelimit-remaining",
      "x-ratelimit-retry",
      "x-ratelimit-limit",
      "x-ratelimit-reset",
      "retry-after",
    ],
    keys: async (session: SqlSession, wanted: Wanted) => {
      const { host } = wanted.aim;
      const need = needOf(host);
      const outcome = await session.query(tokensQuery(host), [
        wanted.clientId,
      ]);
      if (outcome.kind !== "rows") return [];
      const { env } = wanted;
      const extras: Extras = {
        secret: headerOf("x-client-secret", env.get("WB_CLIENT_SECRET")),
        open: headerOf("user-agent", env.get("WB_USER_AGENT")),
      };
      return [...tokensBySid(outcome.rows)].map(([sid, tokens]): CabinetKey => {
        const token = preference.choose(tokens);
        if (token === undefined) {
          return new MissingToken(sid, need.wanted);
        }
        return new WbKey(sid, token.value, extras);
      });
    },
  };
}

/** Справка обоих сообщений; получатель у каждого свой — предпочтение. */
function receiverOf(preference: Preference): Receiver {
  return {
    marketplace: wb(preference),
    help: {
      cabinetId: "sid",
      key:
        `Токен кабинета — из public.wb_tokens сервера клиента read-only сессией:
действующий, не истёкший, категории хоста; у call-ro — с read_only, если
такой есть (запись тогда запрещает сам WB), у call — без read_only. Токен
и X-Client-Secret наружу не выходят: ни в вывод, ни в журнал, ни в текст
отказа; эхо в теле ответа заменяется на ***.`,
      body:
        "body: — JSON-текст тела; с ним метод по умолчанию POST, без него — GET.",
      requests: "Один вызов — один запрос",
      dry: "authorization: ***",
      refusals:
        "хост не из API Wildberries, нет действующего токена категории хоста, ",
    },
  };
}

export const wbCallRoCommand = callMessage(receiverOf(READ_ONLY_FIRST), {
  name: "call-ro",
  policy: "ro",
  access: new ReadList(READS),
  summary:
    "что сейчас отвечает ручка чтения Wildberries API под токеном кабинета клиента",
  help: `Звать, когда нужен живой ответ Wildberries API по кабинету клиента:
что отдаёт ручка, сколько осталось квоты, какой x-ratelimit-retry. Токен
нужной категории подставляет mpu из БД клиента — в руки его брать не
нужно. Только ручки из списка чтения; прочие — отказ до чтения токена с
готовой строкой mpu ask wb call.`,
  examples: [
    "mpu wb call-ro target: 54 url: https://common-api.wildberries.ru/api/v1/seller-info",
    "mpu wb call-ro target: 54 url: https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=2026-09-01",
    "mpu wb call-ro dry target: 54 url: https://common-api.wildberries.ru/api/v1/seller-info",
  ],
});

export const wbCallCommand = callMessage(receiverOf(WRITABLE_FIRST), {
  name: "call",
  policy: "rw",
  access: ANY_REQUEST,
  summary:
    "вызвать любую ручку Wildberries API под токеном кабинета клиента (запись)",
  help: `Звать, когда ручка меняет данные кабинета у WB (цены, карточки,
кампании) или её нет в списке чтения mpu wb call-ro. Идёт только через
дверь ask: вызов с подтверждением человека. Изменение, которое делает
ручка, — у WB, и отменить его mpu не может.`,
  examples: [
    "mpu ask wb call target: 54 url: https://content-api.wildberries.ru/content/v2/get/cards/list body: {}",
  ],
});

/** Сообщения получателя `wb`. */
export const wbCommands = [wbCallRoCommand, wbCallCommand];
