/**
 * Что команда спрашивает у Loki (`docs/specs/logs.md`, «CLI-контракт»):
 * разбор `--since`, границы окна и сборка LogQL. Ни сети, ни времени
 * суток здесь нет — момент отсчёта передаётся параметром, поэтому
 * запрос воспроизводим в тестах побайтово.
 */

import { UsageError } from "../command/mod.ts";

/** Единицы относительного `--since` и их длительность в миллисекундах. */
const UNITS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Разобранное значение `--since`. */
export type Since =
  | { readonly kind: "absolute"; readonly unixSeconds: number }
  | { readonly kind: "relative"; readonly ms: number };

/**
 * `--since`: одни цифры — абсолютный unix-ts (`--since 60` это ts 60, а
 * не «60 секунд назад»); `<число>` с единицей `s|m|h|d` — сдвиг назад от
 * текущего момента. Прочее — ошибка ввода, до всякой сети.
 */
export function parseSince(raw: string): Since {
  if (/^\d+$/.test(raw)) {
    return { kind: "absolute", unixSeconds: Number(raw) };
  }
  const matched = /^(\d+)([smhd])$/.exec(raw);
  if (matched === null) {
    throw new UsageError(
      `--since: ожидается <число>{s|m|h|d} или unix-ts, получено '${raw}'`,
    );
  }
  return { kind: "relative", ms: Number(matched[1]) * UNITS[matched[2]] };
}

/**
 * Начало окна в миллисекундах: абсолютный `--since` — как задан,
 * относительный — сдвиг назад от `nowMs`, не задан — умолчание вызова
 * (`defaultMs`: 5 минут у разового запроса, 10 секунд у слежения).
 */
export function windowStartMs(
  since: Since | undefined,
  nowMs: number,
  defaultMs: number,
): number {
  if (since === undefined) return nowMs - defaultMs;
  return since.kind === "absolute"
    ? since.unixSeconds * 1000
    : nowMs - since.ms;
}

/** Момент в миллисекундах — в наносекунды unix-времени. */
export function toNanoseconds(ms: number): bigint {
  return BigInt(Math.trunc(ms)) * 1_000_000n;
}

/** Из чего собирается LogQL запроса; порядок частей задан спекой. */
export interface LogQlParts {
  /** Хост; не задан — фильтра по хосту нет (`host=~".+"`). */
  readonly host?: string;
  /** Значение лейбла `compose_service`. */
  readonly service?: string;
  readonly noStdout: boolean;
  readonly noStderr: boolean;
  /** Подстроки `--grep` в порядке ввода. */
  readonly greps: readonly string[];
  /** Регулярные выражения `--grep-regex` в порядке ввода. */
  readonly regexes: readonly string[];
  /** `--client`: подстрока десятичной записи числа. */
  readonly client?: number;
  readonly level?: string;
}

/**
 * LogQL по спеке: label-блок через запятую без пробелов, затем
 * line-фильтры через один пробел — сначала `|=` каждого `--grep`, потом
 * `|~` каждого `--grep-regex`, потом `--client` подстрокой и последним
 * `--level`.
 */
export function buildLogQl(parts: LogQlParts): string {
  const labels = [
    parts.host === undefined
      ? 'host=~".+"'
      : `host="${labelValue(parts.host)}"`,
  ];
  if (parts.service !== undefined) {
    labels.push(`compose_service="${labelValue(parts.service)}"`);
  }
  // Инверсия: `--no-stdout` убирает поток stdout, то есть просит записи,
  // у которых лейбл `stream` — не он.
  if (parts.noStdout) labels.push('stream!="stdout"');
  if (parts.noStderr) labels.push('stream!="stderr"');

  const filters = [
    ...parts.greps.map((value) => `|= ${lineValue(value)}`),
    ...parts.regexes.map((value) => `|~ ${lineValue(value)}`),
  ];
  if (parts.client !== undefined) {
    filters.push(`|= ${lineValue(String(parts.client))}`);
  }
  if (parts.level !== undefined) {
    filters.push(`| detected_level="${labelValue(parts.level.toLowerCase())}"`);
  }
  return [`{${labels.join(",")}}`, ...filters].join(" ");
}

/** Значение лейбла в двойных кавычках: экранируются `\` и `"`. */
function labelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Значение line-фильтра: в backtick-кавычках, где экранировать нечего.
 * Сам backtick внутри значения закрыл бы кавычку — такое значение
 * записывается в двойных кавычках с экранированием, как у лейбла.
 */
function lineValue(value: string): string {
  return value.includes("`") ? `"${labelValue(value)}"` : `\`${value}\``;
}
