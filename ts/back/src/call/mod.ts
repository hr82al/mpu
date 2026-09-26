/**
 * Публичная поверхность модуля: вызов API маркетплейса под ключом
 * кабинета клиента (`docs/specs/call.md`) — сообщения получателей `ozon`,
 * `ozon perf` и `wb`.
 */

export { ozonCallCommand, ozonCallRoCommand, ozonCommands } from "./ozon.ts";
export {
  ozonPerfCallCommand,
  ozonPerfCallRoCommand,
  ozonPerfCommands,
} from "./ozonPerf.ts";
export { wbCommands } from "./wb.ts";
