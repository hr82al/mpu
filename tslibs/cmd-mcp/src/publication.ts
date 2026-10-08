/**
 * Закрытый список публикации (`platform/mcp-server.md`): какие команды
 * реестра становятся тулами, с какой политикой и какие из них
 * необратимы. Список перечисляет команды приложения, поэтому пакет его
 * не знает — его приносит потребитель из канала спецификаций
 * (`fixtures/mcp-server/tool-policies.json`), а решения над ним
 * принимает этот объект.
 */

import type { Command, Policy } from "@mpu/command";
import type { Profile, ToolEntry } from "./tool.ts";

/** Расхождение объявленной политики с закрытым списком публикации. */
export class ToolPolicyError extends Error {
  override name = "ToolPolicyError";
}

/** Форма списка в канале: имена команд — пути через пробел. */
export interface PublicationList {
  readonly ro: readonly string[];
  readonly rw: readonly string[];
  /** Подмножество `rw`: тулы, требующие подтверждения на каждый вызов. */
  readonly destructive: readonly string[];
}

/** Закрытый список публикации и решения над ним. */
export class Publication {
  readonly #ro: readonly string[];
  readonly #rw: readonly string[];
  readonly #destructive: readonly string[];

  /** Список копируется: правка исходного массива его не меняет. */
  constructor(list: PublicationList) {
    this.#ro = [...list.ro];
    this.#rw = [...list.rw];
    this.#destructive = [...list.destructive];
  }

  /**
   * Профиль команды контракта по закрытому списку; команды нет в
   * списке — она не публикуется. Расхождение политики в коде с
   * политикой списка — отказ собрать тулы, а не молчаливый выбор одной
   * из двух (инвариант спеки).
   */
  policyOf(command: Command): Policy | undefined {
    const name = command.path.join(" ");
    const listed = this.#listed(name);
    if (listed === undefined) return undefined;
    if (listed !== command.policy) {
      throw new ToolPolicyError(
        `${name}: политика в коде (${command.policy}) расходится ` +
          `с закрытым списком публикации (${listed})`,
      );
    }
    return listed;
  }

  /** Необратим ли эффект команды: решает секция `destructive`. */
  isDestructive(name: string): boolean {
    return this.#destructive.includes(name);
  }

  /**
   * Имя из секции `destructive`, которого нет среди публикуемых, — ошибка
   * сборки списка, а не молчаливый пропуск: иначе переименование команды
   * тихо снимет подтверждение с необратимого действия.
   *
   * Профиль сужает проверку: секция — подмножество `rw`, и при сборке
   * `ro` спрашивать с неё нечего.
   */
  assertDestructivePublished(
    entries: readonly ToolEntry[],
    profile: Profile,
  ): void {
    if (profile !== "rw") return;
    const published = new Set(entries.map((entry) => entry.path.join(" ")));
    const missing = this.#destructive.filter((name) => !published.has(name));
    if (missing.length > 0) {
      throw new ToolPolicyError(
        `секция destructive называет неопубликованные команды: ${missing.join(
          ", ",
        )}`,
      );
    }
  }

  #listed(name: string): Policy | undefined {
    if (this.#ro.includes(name)) return "ro";
    if (this.#rw.includes(name)) return "rw";
    return undefined;
  }
}
