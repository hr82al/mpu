/**
 * Публичная поверхность модуля: вызов API маркетплейса под ключом
 * кабинета клиента (`docs/specs/call.md`) — сообщения получателей `ozon`
 * и `ozon perf`.
 */

export { ozonCallCommand, ozonCallRoCommand, ozonCommands } from "./ozon.ts";
export {
  ozonPerfCallCommand,
  ozonPerfCallRoCommand,
  ozonPerfCommands,
} from "./ozonPerf.ts";
