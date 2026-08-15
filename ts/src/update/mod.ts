/**
 * Публичная поверхность команды `mpu update` (`docs/specs/update.md`):
 * синк снапшота кэш-БД с PG. Кроме самой команды наружу смотрят две
 * возможности без CLI — полный синк и точечный синк одного клиента: их
 * зовёт поисковая команда (fallback пустого поиска и точечное
 * обновление), когда та переедет.
 */

export {
  runUpdate,
  type UpdateArgs,
  updateCommand,
  type UpdateLimits,
  type UpdateOptions,
  type UpdateResult,
} from "./cmd_update.ts";
export {
  ClientNotFoundError,
  type ClientSyncOutcome,
  CONNECT_TIMEOUT_MS,
  DEFAULT_PG_LIMITS,
  type FailedServer,
  MainUnavailableError,
  type OpenPgSession,
  type PgLimits,
  type PgSession,
  QUERY_TIMEOUT_MS,
  type SelectOptions,
  type SnapshotOutcome,
  syncClient,
  type SyncDeps,
  syncSnapshot,
} from "./sync.ts";
export { type PgRow, PgRowError, type PgValue } from "./cache.ts";
