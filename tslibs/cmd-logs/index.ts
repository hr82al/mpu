/**
 * Поверхность пакета: команда `mpu logs` (`logs.md`) — логи сервисов
 * стенда запросом в Loki либо legacy-снимком контейнера через Portainer —
 * и запись итога discovery Loki в кэш-БД, которую читает `logs`
 * (`platform/loki-http.md`, «Инварианты»): её же зовут `init` и `update`.
 */

export {
  type LogsArgs,
  logsCommand,
  type LogsOptions,
  type LogsResult,
  runLogs,
} from "./src/cmd_logs.ts";
export { writeLokiCache } from "./src/loki_cache.ts";
