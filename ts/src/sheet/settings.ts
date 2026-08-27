/**
 * Настройки семейства `mpu sheet` (`platform/webapp-http.md`,
 * «Конфигурация»): цель по умолчанию, адрес webapp и int-ключи кэша.
 *
 * Нечисловое значение слоя не роняет вызов: оно уходит заметкой в
 * журнал, а действует следующий слой — команда читает таблицу, а не
 * чинит конфигурацию.
 */

import { type CacheDb, type CommandIo, DomainError } from "../command/mod.ts";
import { configValue } from "../config/mod.ts";
import type { CacheSettings } from "./cache.ts";

/** Умолчания int-ключей кэша. */
const DEFAULTS: CacheSettings = {
  tabTtlSeconds: 7200,
  maxTabBytes: 10_485_760,
  maxTotalMb: 500,
};

/**
 * Ключ конфигурации → поле настроек. Переменных окружения здесь нет:
 * параметры кэша задаются только конфигом (`sheet.md`, «Открытые
 * вопросы»).
 */
const INT_KEYS = [
  ["sheet.cache.tab_ttl", "tabTtlSeconds"],
  ["sheet.cache.max_tab_bytes", "maxTabBytes"],
  ["sheet.cache.max_total_mb", "maxTotalMb"],
] as const;

/** Адрес webapp; без него сетевые подкоманды работать не могут. */
export function webappUrl(io: Pick<CommandIo, "envFile">): string {
  const url = io.envFile.get("WB_PLUS_WEB_APP_URL");
  if (url === undefined || url === "") {
    // Доменная ошибка, а не ввода: команда набрана верно, не хватает
    // окружения (`sheet.md`, exit 1).
    throw new DomainError(
      io.envFile.require === undefined ? "" : missingUrl(io),
    );
  }
  return url;
}

/** Текст отсутствия ключа — слоя env-файла, с путём файла. */
function missingUrl(io: Pick<CommandIo, "envFile">): string {
  try {
    io.envFile.require("WB_PLUS_WEB_APP_URL");
  } catch (err) {
    if (err instanceof Error) return err.message;
  }
  return "WB_PLUS_WEB_APP_URL не задан";
}

/**
 * Настройки кэша: предпочтения, затем умолчание. Таблица читается из
 * уже открытой кэш-БД — второго соединения ради трёх ключей не
 * заводится, и настройки не могут разойтись с данными, которые ими
 * чистятся.
 */
export function cacheSettings(
  io: Pick<CommandIo, "note">,
  db: CacheDb,
): CacheSettings {
  const settings: {
    tabTtlSeconds: number;
    maxTabBytes: number;
    maxTotalMb: number;
  } = { ...DEFAULTS };
  for (const [key, field] of INT_KEYS) {
    const value = numberOf(io, configValue(db, key), key);
    if (value !== undefined) settings[field] = value;
  }
  return settings;
}

/** Целое из строки; нечисловое — заметка в журнал и следующий слой. */
function numberOf(
  io: Pick<CommandIo, "note">,
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  io.note(`sheet: ${name}='${raw}' — не целое, значение пропущено`);
  return undefined;
}
