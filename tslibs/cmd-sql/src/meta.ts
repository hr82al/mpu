/**
 * Мета-блок команд `mpu sql-ro` и `mpu sql` (`specs/sql-ro.md`,
 * «Ввод/вывод»): куда идёт запрос и какой текст уходит серверу.
 * Печатается в stderr ⇔ `--verbose` или `--dry`; кредов в нём нет и быть
 * не может.
 */

import type { SqlMode } from "./session.ts";

/** Что показывает мета-блок. */
export interface MetaBlock {
  /** `sl-<N>` либо `dev`. */
  readonly server: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Схема клиента; search_path не ставится — `null`. */
  readonly searchPath: string | null;
  /** Текст SQL как введён. */
  readonly sql: string;
}

/** Текст блока; всегда завершается ровно одним переводом строки. */
export function metaText(meta: MetaBlock, mode: SqlMode): string {
  const lines = [
    `server: ${meta.server}`,
    `pg_host: ${meta.host}`,
    `pg_port: ${meta.port}`,
    `database: ${meta.database}`,
  ];
  if (meta.searchPath !== null) {
    lines.push(`search_path: ${meta.searchPath}, public`);
  }
  // Строка режима — признак enforced read-only сессии; у `mpu sql` её
  // нет, и это единственное наблюдаемое отличие мета-блоков
  // (`specs/sql.md`, «CLI-контракт»).
  if (mode === "read-only") lines.push("mode: read-only");
  lines.push("sql:");
  const sql = meta.sql.endsWith("\n") ? meta.sql : `${meta.sql}\n`;
  return `${lines.join("\n")}\n${sql}`;
}
