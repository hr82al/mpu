/**
 * Публичная поверхность модуля: ad-hoc SQL по селектору — команды
 * `mpu sql-ro` (`docs/specs/sql-ro.md`), `mpu sql` (`docs/specs/sql.md`)
 * и общий для них ход вызова.
 */

// Наружу выведены и части подключения: ими пользуется `mpu backup-*`
// (`docs/specs/backup.md`) — команда не из семейства обёрток, но с тем
// же адресом сервера и теми же кредами. Второй копии правил
// подключения быть не должно.
export { DbError, type OpenSession, type SqlMode } from "./session.ts";
export { type PgTarget, serverTarget } from "./target.ts";

export { sqlCommand } from "./cmd_sql.ts";
export { sqlRoCommand } from "./cmd_sql_ro.ts";
export {
  denoSession,
  runSql,
  type SqlArgs,
  type SqlIo,
  type SqlOptions,
  type SqlResult,
} from "./run.ts";
