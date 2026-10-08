/**
 * Поверхность пакета: команда `mpu log` (`log.md`) — чтение журнала
 * вызовов. `runLog` — ход команды без разбора аргументов: его берёт тест
 * строки потребителя.
 */

export {
  type LogArgs,
  logCommand,
  type LogIo,
  type LogOptions,
  type LogResult,
  runLog,
} from "./src/cmd_log.ts";
