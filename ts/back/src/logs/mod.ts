/**
 * Публичная поверхность команды `mpu logs` (`docs/specs/logs.md`): логи
 * сервисов стенда — запросом в Loki либо legacy-снимком контейнера
 * через Portainer.
 */

export {
  type LogsArgs,
  logsCommand,
  type LogsOptions,
  type LogsResult,
  runLogs,
} from "./cmd_logs.ts";
