/**
 * Публичная поверхность команды `mpu sql-ro` (`docs/specs/sql-ro.md`):
 * ad-hoc SQL по селектору в enforced read-only сессии PostgreSQL.
 */

export {
  runSqlRo,
  type SqlRoArgs,
  sqlRoCommand,
  type SqlRoOptions,
  type SqlRoResult,
} from "./cmd_sql_ro.ts";
