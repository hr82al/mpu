/**
 * Реестр ключей предпочтений (`platform/config.md`, «CLI-контракт»):
 * протокол объявления ключа и закрытый список, собранный из объявлений.
 *
 * Ключ объявляет его домен — пакет команды, которая значение применяет
 * (`sheet.cache.*` — `sheet`, `task.history` — `task`); список
 * собирает приложение в порядке спеки. Порядок вывода — контракт, и он
 * не совпадает с группировкой по доменам (`xlsx.default` стоит между
 * ключами `sheet`), поэтому собирает его одно место, а не сцепка
 * списков пакетов.
 *
 * Закрытый — значит обращение к имени вне списка никогда не создаёт
 * запись «на лету»: опечатка в ключе обязана быть отказом, а не тихо
 * осевшей строкой, которую потом никто не найдёт.
 */

/** Тип значения ключа; от него зависит и валидация, и печать. */
export type ConfigKeyType = "str" | "int";

/**
 * Умолчание потребителя по `HOME` порта команды: не зависящее от него,
 * выведенное из него или отсутствующее (`undefined`).
 */
export type Fallback = (home: string | undefined) => string | undefined;

/** Умолчания нет: не задано — значит не задано. */
export const NO_FALLBACK: Fallback = () => undefined;

/** Постоянное умолчание. */
export function fixed(value: string): Fallback {
  return () => value;
}

/** Путь под `HOME`; `HOME` нет — умолчания нет (`platform/config.md`). */
export function underHome(path: string): Fallback {
  return (home) => (home === undefined ? undefined : `${home}/${path}`);
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

/**
 * Закрытый список ключей в порядке объявления — в этом же порядке их
 * печатает вывод. Список копируется при сборке: собравший его не правит
 * реестр задним числом.
 */
export class ConfigRegistry {
  readonly #keys: readonly ConfigKey[];

  constructor(keys: readonly ConfigKey[]) {
    this.#keys = [...keys];
  }

  /** Ключи по порядку объявления. */
  get entries(): readonly ConfigKey[] {
    return this.#keys;
  }

  /** Ключ по имени; имени нет в списке — `undefined`. */
  find(name: string): ConfigKey | undefined {
    return this.#keys.find((entry) => entry.key === name);
  }

  /** Имена ключей через запятую — для подсказки при опечатке. */
  names(): string {
    return this.#keys.map((entry) => entry.key).join(", ");
  }
}
