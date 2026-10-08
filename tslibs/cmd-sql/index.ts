/**
 * Поверхность пакета: команды `mpu sql-ro` (`sql-ro.md`) и `mpu sql`
 * (`sql.md`) — ad-hoc SQL по селектору — и общий для них ход вызова.
 *
 * Наружу выведены и части подключения: ими пользуются соседние команды
 * того же сервера — `mpu backup-*` (`backup.md`), `mpu ozon call`
 * (`call.md`), копирования (`copy-client.md`), чистка локальных клиентов.
 * Второй копии правил подключения быть не должно. Сам драйвер — вход
 * `@mpu/cmd-sql/pg`: этот вход его не грузит.
 */

export { sqlCommand } from "./src/cmd_sql.ts";
export { sqlRoCommand } from "./src/cmd_sql_ro.ts";
export type { SqlOutcome } from "./src/render.ts";
export {
  denoSession,
  runSql,
  type SqlArgs,
  type SqlIo,
  type SqlOptions,
  type SqlResult,
} from "./src/run.ts";
export {
  DbError,
  type OpenSession,
  type SqlMode,
  type SqlSession,
  type Statement,
  StatementError,
} from "./src/session.ts";
export {
  devTarget,
  type PgTarget,
  routeOf,
  serverTarget,
} from "./src/target.ts";
