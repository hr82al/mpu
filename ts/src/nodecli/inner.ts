/**
 * Сборка inner-команды sl-back CLI (`platform/portainer.md`, «Сборка
 * inner-команды»): `node cli service:<сервис> <метод> [флаги]`.
 *
 * Одна и та же строка уходит во все три режима доставки — выполнение,
 * печать ssh-формы и печать локальной формы, — поэтому собирается она
 * здесь, в одном месте: разойтись режимам нельзя (инвариант спеки).
 */

import { UsageError } from "../command/mod.ts";

/**
 * Допустимые символы значения (`SafeToken` глоссария). Значение
 * подставляется в двойные кавычки внутри одинарных, и whitelist — то,
 * что делает подстановку безопасной без квотирования.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_./:,@[\]-]+$/;

/** Значение флага: чем оно бывает и во что превращается. */
export type FlagValue =
  | string
  | number
  | boolean
  | readonly (string | number)[]
  | null
  | undefined;

/** Флаг inner-команды в порядке объявления. */
export interface Flag {
  readonly name: string;
  readonly value: FlagValue;
}

/** Из чего собирается inner-команда. */
export interface InnerCommand {
  readonly service: string;
  readonly method: string;
  readonly flags: readonly Flag[];
}

/**
 * Токены inner-команды. Порядок флагов — порядок объявления и никогда
 * не сортируется: он часть контракта нижестоящего парсера.
 */
export function innerTokens(inner: InnerCommand): readonly string[] {
  const tokens = ["node", "cli", `service:${inner.service}`, inner.method];
  for (const flag of inner.flags) tokens.push(...flagTokens(flag));
  return tokens;
}

/** Та же команда одной строкой: токены через одиночные пробелы. */
export function innerText(inner: InnerCommand): string {
  return innerTokens(inner).join(" ");
}

/**
 * Токены одного флага. Пустое значение и `false` не оставляют следа
 * вовсе — ни флага, ни значения; `true` даёт флаг без значения.
 */
function flagTokens(flag: Flag): readonly string[] {
  const name = flagName(flag.name);
  const value = flag.value;
  if (value === undefined || value === null || value === false) return [];
  if (value === true) return [name];
  if (Array.isArray(value)) {
    // Пустой список равнозначен незаданному флагу: sl-back CLI читает
    // подряд идущие не-флаговые токены массивом, и флаг без них значил
    // бы пустую строку.
    if (value.length === 0) return [];
    return [name, ...value.map((item) => safe(item, name))];
  }
  return [name, safe(value as string | number, name)];
}

/**
 * Имя флага в каноничном виде: ведущие `--` необязательны, `_` — то же,
 * что `-` (`client_id` / `--client-id` → `--client-id`).
 */
function flagName(raw: string): string {
  return `--${raw.replace(/^--/, "").replaceAll("_", "-")}`;
}

/**
 * Значение, годное для подстановки без квотирования. Имя команды в
 * префикс отказа подставляет форматирование ошибки — у семейства это
 * имя обёртки, а у группы имя группы (`specs/portainer-wrappers.md`).
 */
function safe(value: string | number, name: string): string {
  const token = String(value);
  if (SAFE_TOKEN.test(token)) return token;
  throw new UsageError(
    `value contains shell-unsafe chars for ${name}: '${token}'`,
  );
}
