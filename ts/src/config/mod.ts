/**
 * Локальное хранилище предпочтений CLI (контракт —
 * docs/specs/platform/config.md): значения ключей реестра и алиасы
 * файлов команды xlsx. Модуль чистый — разбор и сериализация; чтение
 * и запись файла (`~/.config/mpu/`, 0600) делает io-слой вызывающего.
 * Значения хранятся строками буквально («007» не нормализуется).
 */

/** Содержимое хранилища. Отсутствующий файл равнозначен пустому. */
export interface StoreData {
  /** Значения ключей реестра конфига (`xlsx.default`, …). */
  readonly values: Readonly<Record<string, string>>;
  /** Алиасы файлов команды xlsx: имя → путь как введён. */
  readonly aliases: Readonly<Record<string, string>>;
}

const EMPTY_STORE: StoreData = { values: {}, aliases: {} };

/** Хранилище нечитаемо; для CLI это инфраструктурная ошибка (exit 1). */
export class StoreFormatError extends Error {
  override name = "StoreFormatError";
}

/** Разбирает содержимое файла хранилища; `undefined` — файла нет. */
export function parseStore(raw: string | undefined): StoreData {
  if (raw === undefined) return EMPTY_STORE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StoreFormatError("config store is not valid JSON", {
      cause: err,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StoreFormatError("config store root is not an object");
  }
  const record = parsed as Record<string, unknown>; // сужение после проверки
  return {
    values: stringMap(record["values"], "values"),
    aliases: stringMap(record["aliases"], "aliases"),
  };
}

/** Сериализует хранилище: JSON с отсортированными ключами + `\n`. */
export function serializeStore(data: StoreData): string {
  const body = JSON.stringify(
    { values: sorted(data.values), aliases: sorted(data.aliases) },
    null,
    2,
  );
  return `${body}\n`;
}

/** Копия хранилища с добавленным/заменённым алиасом. */
export function withAlias(
  data: StoreData,
  name: string,
  path: string,
): StoreData {
  return { values: data.values, aliases: { ...data.aliases, [name]: path } };
}

/** Копия хранилища без алиаса; отсутствие имени — не ошибка. */
export function withoutAlias(data: StoreData, name: string): StoreData {
  const { [name]: _removed, ...rest } = data.aliases;
  return { values: data.values, aliases: rest };
}

function stringMap(
  value: unknown,
  field: string,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreFormatError(
      `config store field "${field}" is not an object`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new StoreFormatError(
        `config store field "${field}.${key}" is not a string`,
      );
    }
    out[key] = item;
  }
  return out;
}

function sorted(
  record: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}
