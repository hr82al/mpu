/**
 * Строки результата SQL коллекцией записей для отбора
 * (`platform/collection-protocol.md`): запись — колонка → значение;
 * обратно — те же колонки в прежнем порядке.
 */

import { z } from "@zod/zod";
import type { Items } from "../command/mod.ts";
import type { SqlResult } from "./run.ts";

/** Записи отбора — от него же: колонка → значение JSON. */
const recordsSchema = z.array(z.record(z.string(), z.json()));

/**
 * Коллекция SQL: строки набора записями. Без набора (`done`, `--dry`) —
 * пусто.
 */
export const SQL_ITEMS: Items<SqlResult> = {
  records(result) {
    const outcome = result.outcome;
    if (outcome?.kind !== "rows") return [];
    return outcome.rows.map((row) =>
      Object.fromEntries(outcome.columns.map((column, i) => [column, row[i]]))
    );
  },
  with(result, records) {
    const outcome = result.outcome;
    if (outcome?.kind !== "rows") return result;
    const rows = recordsSchema.parse(records).map((record) =>
      outcome.columns.map((column) => record[column] ?? null)
    );
    return { ...result, outcome: { ...outcome, rows } };
  },
};
