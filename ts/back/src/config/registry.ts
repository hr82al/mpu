/**
 * Реестр ключей предпочтений (`platform/config.md`, «CLI-контракт»):
 * закрытый список из шести имён с типом, умолчанием и описанием.
 *
 * Закрытый — значит обращение к имени вне списка никогда не создаёт
 * запись «на лету»: опечатка в ключе обязана быть отказом, а не тихо
 * осевшей строкой, которую потом никто не найдёт.
 *
 * Описания — дословно из голденов рабочей версии
 * (`fixtures/config/list-json.stdout`): их читает человек в выводе
 * `mpu config --json`, и расходиться двум текстам об одном ключе
 * незачем. У нашего ключа `image.dir`, которого в оригинале нет,
 * описание своё, в том же стиле.
 */

/** Тип значения ключа; от него зависит и валидация, и печать. */
export type ConfigKeyType = "str" | "int";

/**
 * Умолчание потребителя по `HOME` порта команды: не зависящее от него,
 * выведенное из него или отсутствующее (`undefined`).
 */
export type Fallback = (home: string | undefined) => string | undefined;

/** Умолчания нет: не задано — значит не задано. */
const NO_FALLBACK: Fallback = () => undefined;

/** Постоянное умолчание. */
function fixed(value: string): Fallback {
  return () => value;
}

/** Путь под `HOME`; `HOME` нет — умолчания нет (`platform/config.md`). */
function underHome(path: string): Fallback {
  return (home) => home === undefined ? undefined : `${home}/${path}`;
}

/** Объявление одного ключа реестра. */
export interface ConfigKey {
  readonly key: string;
  readonly type: ConfigKeyType;
  /** Умолчание потребителя по `HOME` порта команды. */
  readonly fallback: Fallback;
  /**
   * Допустимые границы int-ключа, включительно; без них принимается
   * любое целое.
   *
   * Границы стоят только там, где значение вне них молча не работает:
   * порт вне 1–65535 сервер не откроет и возьмёт умолчание, то есть
   * `mpu config` показывал бы одно, а слушалось бы другое. У
   * `sheet.cache.*` границ нет намеренно — оригинал принимает и ноль, и
   * миллиард, а потребитель кэша отбрасывает несуразное сам, с заметкой
   * в журнал (`platform/config.md`, отклонение preserve).
   */
  readonly range?: { readonly min: number; readonly max: number };
  readonly description: string;
}

/** Ключи по порядку объявления — в этом же порядке их печатает вывод. */
export const CONFIG_KEYS: readonly ConfigKey[] = [
  {
    key: "sheet.default",
    type: "str",
    fallback: NO_FALLBACK,
    description:
      "Spreadsheet по умолчанию (ID/URL/alias/client_id/title) для `mpu sheet`",
  },
  {
    key: "xlsx.default",
    type: "str",
    fallback: NO_FALLBACK,
    description: "Путь или alias .xlsx по умолчанию для `mpu xlsx`",
  },
  {
    key: "sheet.cache.tab_ttl",
    type: "int",
    fallback: fixed("7200"),
    description: "TTL whole-tab кэша листов, секунды",
  },
  {
    key: "sheet.cache.max_tab_bytes",
    type: "int",
    fallback: fixed("10485760"),
    description: "Порог, выше которого таб не кэшируется, байты (после gzip)",
  },
  {
    key: "sheet.cache.max_total_mb",
    type: "int",
    fallback: fixed("500"),
    description: "Общий потолок кэша листов, МБ",
  },
  {
    key: "image.dir",
    type: "str",
    fallback: underHome("mr/mp/mpu/image"),
    description:
      "Каталог файлов методов образа для `mpu image sync` и `mpu image export`",
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
