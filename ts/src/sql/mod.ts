/**
 * Публичная поверхность модуля: ad-hoc SQL по селектору — команда
 * `mpu sql-ro` (`docs/specs/sql-ro.md`) и общий для неё ход вызова.
 */

export { sqlRoCommand } from "./cmd_sql_ro.ts";
export {
  runSql,
  type SqlArgs,
  type SqlIo,
  type SqlOptions,
  type SqlResult,
} from "./run.ts";
