/**
 * Мета-блок `mpu sql-ro` (`specs/sql-ro.md`, «Ввод/вывод»): куда идёт
 * запрос и какой текст уходит серверу. Печатается в stderr ⇔ `--verbose`
 * или `--dry`; кредов в нём нет и быть не может.
 */

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
export function metaText(meta: MetaBlock): string {
  const lines = [
    `server: ${meta.server}`,
    `pg_host: ${meta.host}`,
    `pg_port: ${meta.port}`,
    `database: ${meta.database}`,
  ];
  if (meta.searchPath !== null) {
    lines.push(`search_path: ${meta.searchPath}, public`);
  }
  // Строка режима — признак enforced read-only сессии: у write-варианта
  // (`specs/sql.md`) её не будет.
  lines.push("mode: read-only", "sql:");
  const sql = meta.sql.endsWith("\n") ? meta.sql : `${meta.sql}\n`;
  return `${lines.join("\n")}\n${sql}`;
}
