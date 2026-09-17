/**
 * Настройки журнала вызовов — ключи `MPU_LOG_*` env-файла
 * (`platform/invoke-log.md`, «Конфигурация»). Источник один: файл;
 * окружение процесса слой не читает (`platform/env-file.md`), поэтому
 * экспорт ключа в shell на журнал бинаря не влияет.
 */

/** Предел байт на поток вывода в записи; 0 — без обрезки. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Порог ротации файла журнала; 0 — не ротировать. */
export const DEFAULT_MAX_BYTES = 50_000_000;

/** Число архивов ротации; 0 — вместо ротации файл удаляется. */
export const DEFAULT_KEEP = 5;

/** Значения `MPU_LOG_ENABLED`, выключающие журнал (любой регистр). */
const OFF_VALUES: readonly string[] = ["0", "off", "false", "no"];

/** Ключи env-файла, читаемые журналом; вынесены ради текстов note. */
const KEY_MAX_OUTPUT_BYTES = "MPU_LOG_MAX_OUTPUT_BYTES";
const KEY_MAX_BYTES = "MPU_LOG_MAX_BYTES";
const KEY_KEEP = "MPU_LOG_KEEP";

/** Разобранные настройки одной записи. */
export interface LogSettings {
  readonly enabled: boolean;
  /** Путь файла журнала; неизвестен — писать некуда. */
  readonly file: string | undefined;
  readonly maxOutputBytes: number;
  readonly maxBytes: number;
  readonly keep: number;
  /** Диагностика разбора: уходит в секцию note текущей записи. */
  readonly notes: readonly string[];
}

/** Ключи env-файла глазами журнала: одно чтение по имени. */
export interface LogEnv {
  readonly get: (name: string) => string | undefined;
}

/** Читает настройки; битое числовое значение — умолчание и note. */
export function readSettings(
  env: LogEnv,
  defaultFile: string | undefined,
): LogSettings {
  const notes: string[] = [];
  const number = (key: string, fallback: number) =>
    readNumber(env, key, fallback, notes);
  return {
    enabled: !OFF_VALUES.includes(
      (env.get("MPU_LOG_ENABLED") ?? "").toLowerCase(),
    ),
    file: value(env, "MPU_LOG_FILE") ?? defaultFile,
    maxOutputBytes: number(KEY_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES),
    maxBytes: number(KEY_MAX_BYTES, DEFAULT_MAX_BYTES),
    keep: number(KEY_KEEP, DEFAULT_KEEP),
    notes,
  };
}

/**
 * Целое неотрицательное значение ключа. Битое значение не отменяет
 * запись и не роняет команду — берётся умолчание, а причина попадает в
 * саму запись (спека, «Конфигурация»).
 */
function readNumber(
  env: LogEnv,
  key: string,
  fallback: number,
  notes: string[],
): number {
  const raw = value(env, key);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    notes.push(
      `${key}=${raw}: не целое неотрицательное число,` +
        ` взято умолчание ${fallback}`,
    );
    return fallback;
  }
  return Number(raw);
}

/** Значение ключа; пустая строка равнозначна незаданному ключу. */
function value(env: LogEnv, name: string): string | undefined {
  const raw = env.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}
