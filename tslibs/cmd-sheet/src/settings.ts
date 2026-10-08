/**
 * Настройки семейства `mpu sheet` (`platform/webapp-http.md`,
 * «Конфигурация»): цель по умолчанию, адрес webapp и int-ключи кэша.
 *
 * Нечисловое значение слоя не роняет вызов: оно уходит заметкой в
 * журнал, а действует следующий слой — команда читает таблицу, а не
 * чинит конфигурацию.
 */

import { type CacheDb, type CommandIo, DomainError } from "@mpu/command";
import {
  type ConfigKey,
  configValue,
  fixed,
  NO_FALLBACK,
} from "@mpu/command/config";
import type { CacheSettings } from "./cache.ts";

/** Умолчания int-ключей кэша; их же показывает `mpu config`. */
export const DEFAULTS: CacheSettings = {
  tabTtlSeconds: 7200,
  maxTabBytes: 10_485_760,
  maxTotalMb: 500,
};

/*
 * Ключи `mpu config` семейства (`platform/config.md`, «CLI-контракт»):
 * объявляет их тот, кто значения применяет, — умолчание ключа и то, что
 * действует без записи, одна константа. Описания — дословно из голденов
 * рабочей версии (`fixtures/config/list-json.stdout`): их читает человек
 * в выводе `mpu config end json`.
 */

/** Цель команд `mpu sheet` по умолчанию; умолчания нет. */
export const SHEET_DEFAULT: ConfigKey = {
  key: "sheet.default",
  type: "str",
  fallback: NO_FALLBACK,
  description:
    "Spreadsheet по умолчанию (ID/URL/alias/client_id/title) для `mpu sheet`",
};

/** TTL кэша листов, секунды. */
export const SHEET_CACHE_TAB_TTL: ConfigKey = {
  key: "sheet.cache.tab_ttl",
  type: "int",
  fallback: fixed(String(DEFAULTS.tabTtlSeconds)),
  description: "TTL whole-tab кэша листов, секунды",
};

/** Порог размера кэшируемого листа, байты. */
export const SHEET_CACHE_MAX_TAB_BYTES: ConfigKey = {
  key: "sheet.cache.max_tab_bytes",
  type: "int",
  fallback: fixed(String(DEFAULTS.maxTabBytes)),
  description: "Порог, выше которого таб не кэшируется, байты (после gzip)",
};

/** Общий потолок кэша листов, МБ. */
export const SHEET_CACHE_MAX_TOTAL_MB: ConfigKey = {
  key: "sheet.cache.max_total_mb",
  type: "int",
  fallback: fixed(String(DEFAULTS.maxTotalMb)),
  description: "Общий потолок кэша листов, МБ",
};

/**
 * Ключ конфигурации → поле настроек. Переменных окружения здесь нет:
 * параметры кэша задаются только конфигом (`sheet.md`, «Открытые
 * вопросы»).
 */
const INT_KEYS = [
  [SHEET_CACHE_TAB_TTL, "tabTtlSeconds"],
  [SHEET_CACHE_MAX_TAB_BYTES, "maxTabBytes"],
  [SHEET_CACHE_MAX_TOTAL_MB, "maxTotalMb"],
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
  for (const [{ key }, field] of INT_KEYS) {
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
