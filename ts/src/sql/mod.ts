/**
 * Публичная поверхность модуля: ad-hoc SQL по селектору — команды
 * `mpu sql-ro` (`docs/specs/sql-ro.md`), `mpu sql` (`docs/specs/sql.md`)
 * и общий для них ход вызова.
 */

export { sqlCommand } from "./cmd_sql.ts";
export { sqlRoCommand } from "./cmd_sql_ro.ts";
export {
  runSql,
  type SqlArgs,
  type SqlIo,
  type SqlOptions,
  type SqlResult,
} from "./run.ts";
