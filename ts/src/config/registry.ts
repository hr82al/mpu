/**
 * Реестр ключей предпочтений (`platform/config.md`, «CLI-контракт»):
 * закрытый список из семи имён с типом, умолчанием и описанием.
 *
 * Закрытый — значит обращение к имени вне списка никогда не создаёт
 * запись «на лету»: опечатка в ключе обязана быть отказом, а не тихо
 * осевшей строкой, которую потом никто не найдёт.
 *
 * Описания — дословно из голденов рабочей версии
 * (`fixtures/config/list-json.stdout`): их читает человек в выводе
 * `mpu config --json`, и расходиться двум текстам об одном ключе
 * незачем. У двух наших ключей (`mcp.*`), которых в оригинале нет,
 * описания свои, в том же стиле.
 */

/** Тип значения ключа; от него зависит и валидация, и печать. */
export type ConfigKeyType = "str" | "int";

/** Объявление одного ключа реестра. */
export interface ConfigKey {
  readonly key: string;
  readonly type: ConfigKeyType;
  /** Умолчание потребителя; у str-ключей без него — `undefined`. */
  readonly fallback: string | undefined;
  readonly description: string;
}

/** Ключи по порядку объявления — в этом же порядке их печатает вывод. */
export const CONFIG_KEYS: readonly ConfigKey[] = [
  {
    key: "mcp.port",
    type: "int",
    fallback: "7337",
    description: "Порт HTTP-сервера `mpu mcp`",
  },
  {
    key: "mcp.legacy_bin",
    type: "str",
    fallback: "~/.local/share/uv/tools/mpu/bin/mpu",
    description: "Путь к прежней реализации для маршрута legacy",
  },
  {
    key: "sheet.default",
    type: "str",
    fallback: undefined,
    description:
      "Spreadsheet по умолчанию (ID/URL/alias/client_id/title) для `mpu sheet`",
  },
  {
    key: "xlsx.default",
    type: "str",
    fallback: undefined,
    description: "Путь или alias .xlsx по умолчанию для `mpu xlsx`",
  },
  {
    key: "sheet.cache.tab_ttl",
    type: "int",
    fallback: "7200",
    description: "TTL whole-tab кэша листов, секунды",
  },
  {
    key: "sheet.cache.max_tab_bytes",
    type: "int",
    fallback: "10485760",
    description: "Порог, выше которого таб не кэшируется, байты (после gzip)",
  },
  {
    key: "sheet.cache.max_total_mb",
    type: "int",
    fallback: "500",
    description: "Общий потолок кэша листов, МБ",
  },
];

/** Ключ реестра по имени; имени нет в списке — `undefined`. */
export function configKey(name: string): ConfigKey | undefined {
  return CONFIG_KEYS.find((entry) => entry.key === name);
}

/** Имена ключей через запятую — для подсказки при опечатке. */
export function configKeyNames(): string {
  return CONFIG_KEYS.map((entry) => entry.key).join(", ");
}
