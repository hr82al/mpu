/**
 * Доменные флаги периода семейства обёрток
 * (`docs/specs/portainer-wrappers.md`): их объявляют четыре команды
 * дословно одинаково, поэтому объявление одно. Сама календарная дата —
 * в `../dates/mod.ts`: её просит и поиск.
 */

import { z } from "@zod/zod";
import { today } from "../dates/mod.ts";
import type { Flag } from "./inner.ts";

/** Начало периода по умолчанию — одно на все обёртки семейства. */
const DEFAULT_DATE_FROM = "2025-01-01";

/**
 * Входы периода: их объявляют четыре обёртки семейства дословно
 * одинаково (`--date-from`, `--date-to` и snake-написания), поэтому
 * объявление одно. Порядок в inner-команде у всех четырёх тоже один —
 * даты идут первыми среди доменных флагов (таблица спеки).
 */
export const periodArgs = {
  "date-from": z.string().optional().describe(
    "начало периода, YYYY-MM-DD (по умолчанию 2025-01-01)",
  ),
  date_from: z.string().optional().describe("то же, что --date-from"),
  "date-to": z.string().optional().describe(
    "конец периода, YYYY-MM-DD (по умолчанию сегодня)",
  ),
  date_to: z.string().optional().describe("то же, что --date-to"),
};

/** Разобранные входы периода: kebab старше snake-написания. */
export type PeriodArgs = {
  readonly "date-from"?: string;
  readonly date_from?: string;
  readonly "date-to"?: string;
  readonly date_to?: string;
};

/**
 * Флаги периода в порядке спеки. Дефолт `--date-to` берётся здесь, то
 * есть в момент вызова, и всегда уходит явным токеном (инвариант спеки).
 */
export function periodFlags(args: PeriodArgs): readonly Flag[] {
  return [
    {
      name: "date-from",
      value: args["date-from"] ?? args.date_from ?? DEFAULT_DATE_FROM,
    },
    { name: "date-to", value: args["date-to"] ?? args.date_to ?? today() },
  ];
}
