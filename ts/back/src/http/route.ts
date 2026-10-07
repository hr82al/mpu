/**
 * Маршрут HTTP-вызова — напрямую или через прокси
 * (`docs/specs/platform/node-runtime.md`, [S.9]; `platform/tslibs-http.md`,
 * [S.6]–[S.7]). Прокси выбирается в одном месте и одинаково под Bun, Deno и
 * Node: явный → окружение → напрямую. Прежде окружение читал `fetch` рантайма
 * сам, и под Node прокси окружения не применялся вовсе.
 *
 * Адрес `http:` через прокси уходит запросом в абсолютной форме к самому
 * прокси — как у `fetch`, без туннеля: CONNECT не на 443 прокси часто режут.
 * Адрес `https:` — туннелем CONNECT (`https-proxy-agent`). Прокси
 * `socks5:`/`socks5h:` — туннелем SOCKS для обеих схем адреса
 * (`socks-proxy-agent`; у `socks5h` имя разрешает прокси) — те же схемы,
 * что понимал клиент Deno (`docs/specs/telegram-log.md`).
 *
 * Агенты туннелей грузятся лениво, на ветке самого туннеля: их зависимость
 * `debug` читает `DEBUG` из окружения при загрузке — это работа при
 * старте каждого потребителя транспорта, а не только вызова через туннель.
 */

import { Buffer } from "node:buffer";
import {
  type Agent,
  type OutgoingHttpHeaders,
  request as httpRequest,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { withoutCredentials } from "./credentials.ts";
import { isStandHost } from "./stand.ts";

/** Окружение процесса в той части, что читает выбор прокси. */
export type ProxyEnv = Readonly<Record<string, string | undefined>>;

/**
 * Чем и с какими опциями открыть запрос. Тип — у `node:https`: его опции
 * шире (`rejectUnauthorized`), а `node:http` лишние просто не читает.
 */
export interface RouteRequest {
  readonly request: typeof httpsRequest;
  readonly options: RequestOptions;
}

/** Способ доставить вызов: живёт один вызов, `close` — в любом исходе. */
export interface Route {
  /**
   * Опции запроса к `url`. `headers` — заголовки клиента: маршрут через
   * прокси добавляет к ним свои.
   */
  readonly open: (
    url: URL,
    headers: OutgoingHttpHeaders,
  ) => Promise<RouteRequest>;
  readonly close: () => void;
}

/** Прокси не годится для запроса: схема или сама запись адреса. */
export class UnusableProxyError extends Error {
  override name = "UnusableProxyError";
  /**
   * Адрес прокси без учётных данных: ошибка уходит в `cause`, а цепочку
   * причин печатают целиком.
   */
  readonly proxy: string;

  /** @param proxy адрес прокси как записан */
  constructor(proxy: string, reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.proxy = withoutCredentials(proxy);
  }
}

/** Что решает маршрут вызова. */
export interface RouteChoice {
  /** Явный прокси вызова; пустая строка — не задан. */
  readonly proxy?: string;
  /** Проверка TLS отключена: такой `https:` идёт напрямую, как прежде. */
  readonly insecure: boolean;
  readonly env: ProxyEnv;
}

/**
 * Маршрут вызова. Напрямую: `https:` без проверки TLS, адрес стенда без
 * явного прокси (`./stand.ts`), адрес из `NO_PROXY` и вызов без прокси вовсе.
 *
 * @throws UnusableProxyError схема прокси не `http:`/`https:`/`socks5:`/
 *   `socks5h:` или адрес не разбирается
 */
export function routeOf(url: URL, choice: RouteChoice): Route {
  if (url.protocol === "https:" && choice.insecure) return DIRECT;
  const proxy = chosenProxy(url, choice);
  if (proxy === undefined) return DIRECT;
  const parsed = parsedProxy(proxy);
  if (SOCKS.has(parsed.url.protocol)) return socks(parsed.url);
  return url.protocol === "https:" ? tunnel(parsed.url) : forward(parsed);
}

/** Прокси вызова по старшинству: явный, затем окружение — кроме стенда. */
function chosenProxy(url: URL, choice: RouteChoice): string | undefined {
  if (choice.proxy !== undefined && choice.proxy !== "") return choice.proxy;
  if (isStandHost(url.hostname)) return undefined;
  return envProxy(url, choice.env);
}

/** Схемы прокси SOCKS, которые понимает маршрут. */
const SOCKS: ReadonlySet<string> = new Set(["socks5:", "socks5h:"]);

/** Соединение с самим адресом; держать нечего. */
const DIRECT: Route = {
  open: (url, headers) =>
    Promise.resolve({
      request: url.protocol === "https:" ? httpsRequest : httpRequest,
      options: {
        hostname: hostOf(url),
        port: portOf(url),
        path: pathOf(url),
        headers,
        // Соединение живёт ровно один вызов. В общем пуле оно переживало
        // отмену вызова, и остановка сервера ждала его вечно (замер —
        // зависание теста молчащего endpoint'а в `init`).
        agent: false,
      },
    }),
  close: () => {},
};

/** `http:` через прокси: запрос с полным адресом уходит самому прокси. */
function forward(proxy: ParsedProxy): Route {
  const { url: at, authorization } = proxy;
  return {
    open: (url, headers) =>
      Promise.resolve({
        request: at.protocol === "https:" ? httpsRequest : httpRequest,
        options: {
          hostname: hostOf(at),
          port: portOf(at),
          // Абсолютная форма — без фрагмента и учётных данных адреса.
          path: `${url.protocol}//${url.host}${pathOf(url)}`,
          headers: {
            ...headers,
            Host: url.host,
            ...(authorization === undefined
              ? {}
              : { "Proxy-Authorization": authorization }),
          },
          agent: false,
        },
      }),
    close: () => {},
  };
}

/** Агент туннеля: держит соединение с прокси и гасит его. */
interface TunnelAgent extends Agent {
  destroy(): void;
}

/** `https:` через прокси: туннель CONNECT, TLS до адреса — внутри него. */
function tunnel(proxy: URL): Route {
  return agentRoute(async () => {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    // Без `keepAlive` соединение с прокси не переживает вызова.
    return new HttpsProxyAgent(proxy, { keepAlive: false });
  });
}

/** Через прокси SOCKS: туннель до адреса, дальше — как напрямую. */
function socks(proxy: URL): Route {
  return agentRoute(async () => {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    return new SocksProxyAgent(proxy);
  });
}

/**
 * Маршрут через агент туннеля: запрос — к самому адресу, соединение даёт
 * агент. Агент заводится на `open` и гасится `close` — в том числе то, что
 * осталось от отменённого вызова.
 */
function agentRoute(make: () => Promise<TunnelAgent>): Route {
  let agent: TunnelAgent | undefined;
  return {
    open: async (url, headers) => {
      agent = await make();
      return {
        request: url.protocol === "https:" ? httpsRequest : httpRequest,
        options: {
          hostname: hostOf(url),
          port: portOf(url),
          path: pathOf(url),
          headers,
          agent,
        },
      };
    },
    close: () => agent?.destroy(),
  };
}

/**
 * Прокси окружения для схемы адреса: своя переменная схемы, затем
 * `ALL_PROXY`; верхний регистр старше нижнего. Адрес из `NO_PROXY` —
 * без прокси.
 */
function envProxy(url: URL, env: ProxyEnv): string | undefined {
  const scheme = url.protocol === "https:" ? "HTTPS_PROXY" : "HTTP_PROXY";
  const proxy = firstSet(env, [scheme, "ALL_PROXY"]);
  if (proxy === undefined) return undefined;
  const bypass = firstSet(env, ["NO_PROXY"]) ?? "";
  return bypassed(url, bypass) ? undefined : proxy;
}

/** Первое непустое значение из имён — каждое в верхнем, затем в нижнем регистре. */
function firstSet(env: ProxyEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    for (const key of [name, name.toLowerCase()]) {
      const value = env[key];
      if (value !== undefined && value !== "") return value;
    }
  }
  return undefined;
}

/**
 * Попадает ли адрес в `NO_PROXY`: список через запятую; `*` — всё;
 * запись — хост целиком или домен (с точкой в начале или без), к которому
 * хост относится; `:порт` у записи сужает её до порта.
 */
function bypassed(url: URL, list: string): boolean {
  const host = hostOf(url).toLowerCase();
  const port = String(portOf(url));
  return list
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => {
      if (entry === "*") return true;
      const [name, entryPort] = splitPort(entry.replace(/^\*?\./, ""));
      if (name === "" || (entryPort !== undefined && entryPort !== port)) {
        return false;
      }
      return host === name || host.endsWith(`.${name}`);
    });
}

/** Запись `хост:порт` — хост и порт; без порта — `undefined` вторым. */
function splitPort(entry: string): readonly [string, string | undefined] {
  const match = /^(.*):(\d+)$/.exec(entry);
  return match === null ? [entry, undefined] : [match[1], match[2]];
}

/** Адрес прокси, пригодный маршруту, и заголовок его учётных данных. */
interface ParsedProxy {
  readonly url: URL;
  /** Учётных данных в адресе нет — поля нет. */
  readonly authorization?: string;
}

/**
 * Разобранный адрес прокси пригодной схемы (`proxyUrl`). Всё, что
 * может отказать, — здесь, до сети: и разбор, и раскодирование учётки.
 */
function parsedProxy(proxy: string): ParsedProxy {
  const url = proxyUrl(proxy);
  if (url.username === "" && url.password === "") return { url };
  let pair: string;
  try {
    pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(
      url.password,
    )}`;
  } catch (err) {
    throw new UnusableProxyError(proxy, "учётные данные не раскодируются", {
      cause: err,
    });
  }
  return {
    url,
    authorization: `Basic ${Buffer.from(pair).toString("base64")}`,
  };
}

/** Адрес прокси со схемой `http:`, `https:`, `socks5:` или `socks5h:`. */
function proxyUrl(proxy: string): URL {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch (err) {
    // Текст рантайма не годится: у Deno он повторяет адрес целиком, с
    // учётными данными.
    throw new UnusableProxyError(proxy, "адрес не разбирается", {
      cause: err,
    });
  }
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    !SOCKS.has(url.protocol)
  ) {
    throw new UnusableProxyError(
      proxy,
      `схема ${url.protocol.replace(":", "")} не поддерживается`,
    );
  }
  return url;
}

/**
 * Хост для соединения: IPv6 — без скобок. `URL.hostname` держит их, а
 * сокет со скобками ищет имя в DNS и не находит (`ENOTFOUND`).
 */
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/** Путь запроса: путь и строка запроса, фрагмент на сервер не уходит. */
function pathOf(url: URL): string {
  return `${url.pathname}${url.search}`;
}

/** Порт адреса: явный или по умолчанию для схемы. */
function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}
