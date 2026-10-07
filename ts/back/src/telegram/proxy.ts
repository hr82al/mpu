/**
 * Прокси Telegram: разбор URL и сборка его обратно для транспорта
 * (`docs/specs/platform/telegram-mtproto.md`, «Прокси»).
 *
 * Прокси задаётся одним URL, а не набором полей: этот формат уже лежит
 * в env-файлах операторов (там же, «Известные отклонения»).
 */

import { withoutCredentials } from "@mpu/http";
import { configError } from "./errors.ts";

/** Вид туннеля: схема URL после приведения синонимов. */
export type ProxyTunnel = "http" | "https" | "socks5" | "socks4";

/** Разобранный URL прокси. */
export interface ProxySettings {
  readonly tunnel: ProxyTunnel;
  readonly host: string;
  readonly port: number;
  /** Учётные данные; их нет — поля отсутствуют. */
  readonly username?: string;
  readonly password?: string;
}

/**
 * Синонимы схем: «h» у SOCKS5 и «a» у SOCKS4 означают резолв имён на
 * стороне прокси, а адреса узлов Telegram приходят числовыми — разницы
 * снаружи нет.
 */
const TUNNELS: Readonly<Record<string, ProxyTunnel>> = {
  "http:": "http",
  "https:": "https",
  "socks5:": "socks5",
  "socks5h:": "socks5",
  "socks4:": "socks4",
  "socks4a:": "socks4",
};

/** Разбирает значение прокси; непригодное — ошибка конфигурации. */
export function parseProxy(raw: string): ProxySettings {
  const url = parseUrl(raw);
  const tunnel = TUNNELS[url.protocol];
  if (tunnel === undefined) {
    throw configError(
      `неподдерживаемая схема прокси '${url.protocol.replace(":", "")}'; ` +
        "попробуй: http/https/socks5/socks4",
    );
  }
  if (url.hostname === "" || url.port === "") throw needsHostPort(raw);
  return {
    tunnel,
    host: url.hostname,
    port: Number(url.port),
    // Percent-последовательности учётных данных декодируются: пароль
    // с «@» или «:» иначе не записать (там же, «Прокси»).
    ...(url.username === "" ? {} : { username: decode(url.username) }),
    ...(url.password === "" ? {} : { password: decode(url.password) }),
  };
}

/** Собирает URL для транспорта: учётные данные кодируются обратно. */
export function proxyUrl(proxy: ProxySettings): string {
  const user =
    proxy.username === undefined
      ? ""
      : `${encodeURIComponent(proxy.username)}${
          proxy.password === undefined
            ? ""
            : `:${encodeURIComponent(proxy.password)}`
        }@`;
  return `${proxy.tunnel}://${user}${proxy.host}:${proxy.port}`;
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw);
  } catch (err) {
    // Без схемы «10.0.0.1:1080» URL не разбирается вовсе, и сказать про
    // него можно ровно то же: нужен host:port со схемой.
    throw needsHostPort(raw, err);
  }
}

/**
 * Отказ разбора. В тексте — URL без учётных данных: пароль прокси не
 * попадает в вывод ни при каком отказе (там же, «Инварианты»).
 */
function needsHostPort(raw: string, cause?: unknown): Error {
  return configError(
    `в прокси-URL нужен host:port — '${withoutCredentials(raw)}'`,
    { cause },
  );
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Одинокий «%» — не percent-последовательность; значение уходит как
    // записано: испортить пароль хуже, чем оставить его дословным.
    return value;
  }
}
