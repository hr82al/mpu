/**
 * Конфигурация отправки в личного бота (`docs/specs/telegram-log.md`,
 * «Конфигурация»).
 *
 * Отдельно от `telegramConfig()`: у сеанса MTProto свои обязательные
 * ключи, и смешение сделало бы отправку в бота заложником входа
 * `mpu init` — она от сессии не зависит вовсе.
 */

import { DomainError } from "../command/mod.ts";
import type { EnvKeys } from "./config.ts";
import { configError } from "./errors.ts";

/** Разобранная конфигурация бота. */
export interface BotConfig {
  readonly token: string;
  /** Единственный адресат; выбор чата команде недоступен по построению. */
  readonly chatId: number;
  /** Username бота; нужен только подсказке в тексте отказа доставки. */
  readonly botName?: string;
  /**
   * Прокси до `api.telegram.org`; не задан ни одним источником — поля
   * нет. Хранится строкой-URL, а не разобранным видом: клиенту нужен
   * именно URL (`Deno.createHttpClient`), тогда как разбор в
   * `./proxy.ts` служит транспорту MTProto и описывает другой набор
   * схем.
   */
  readonly proxy?: string;
}

/**
 * Источники прокси по старшинству — те же, что у сеанса MTProto
 * (`platform/telegram-mtproto.md`, «Прокси»): канал другой, а сеть до
 * Telegram одна, и заводить боту отдельный ключ значило бы настраивать
 * одно и то же дважды.
 */
const PROXY_KEYS = ["TELEGRAM_PROXY", "HTTPS_PROXY", "https_proxy"] as const;

/**
 * Схемы, которые понимает HTTP-клиент Deno. Список уже, чем у MTProto:
 * `socks4`/`socks4a` клиент отвергает («invalid proxy url»), и знать об
 * этом лучше до сети — иначе отказ пришёл бы безымянным.
 */
const PROXY_SCHEMES = ["http:", "https:", "socks5:", "socks5h:"] as const;

/** Читает конфигурацию; непригодное значение — ошибка конфигурации. */
export function botConfig(env: EnvKeys): BotConfig {
  const token = required(env, "TELEGRAM_BOT_TOKEN");
  const chatId = required(env, "TELEGRAM_BOT_ID");
  // Минус в начале — обычный вид id группы или канала, поэтому знак
  // разрешён; всё прочее означает, что в ключе лежит не идентификатор.
  if (!/^-?\d+$/.test(chatId)) {
    throw configError(
      `TELEGRAM_BOT_ID должен быть числом, получено '${chatId}'`,
    );
  }
  const botName = env.get("TELEGRAM_BOT_NAME");
  const proxy = proxyValue(env);
  return {
    token,
    chatId: Number(chatId),
    // Пустое значение равнозначно незаданному — поле не заводится.
    ...(botName === undefined || botName === "" ? {} : { botName }),
    ...(proxy === undefined ? {} : { proxy: checkedProxy(proxy) }),
  };
}

/** Обязательный ключ: сообщение слоя env-файла несёт имя ключа и путь. */
function required(env: EnvKeys, name: string): string {
  try {
    return env.require(name);
  } catch (err) {
    if (err instanceof DomainError) {
      throw configError(err.message, { cause: err });
    }
    throw err;
  }
}

/** Первый непустой источник прокси; ни одного — `undefined`. */
function proxyValue(env: EnvKeys): string | undefined {
  for (const key of PROXY_KEYS) {
    const value = env.get(key);
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * Прокси-URL, пригодный клиенту. Проверяется здесь, а не при вызове:
 * непригодная схема — свойство настройки, и называть её отказом сети
 * («no response headers within 3000ms») значит прятать причину.
 */
function checkedProxy(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(`прокси-URL неразбираем — '${value}'`);
  }
  if (!PROXY_SCHEMES.includes(url.protocol as typeof PROXY_SCHEMES[number])) {
    const scheme = url.protocol.replace(":", "");
    throw configError(
      `Bot API не умеет прокси ${scheme}; поддерживаются` +
        " http/https/socks5/socks5h (у mpu telegram send прокси свой," +
        " через MTProto, и socks4 там работает)",
    );
  }
  if (url.hostname === "" || url.port === "") {
    throw configError(`в прокси-URL нужен host:port — '${value}'`);
  }
  return value;
}
