/**
 * Команда `mpu log` (`docs/specs/log.md`): чтение журнала вызовов.
 * Публичная поверхность модуля — этот файл.
 */

export {
  type LogArgs,
  logCommand,
  type LogIo,
  type LogOptions,
  type LogResult,
  runLog,
} from "./cmd_log.ts";
