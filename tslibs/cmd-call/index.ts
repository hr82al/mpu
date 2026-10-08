/**
 * Публичная поверхность модуля: вызов API маркетплейса под ключом
 * кабинета клиента (`docs/specs/call.md`) — сообщения получателей `ozon`,
 * `ozon perf` и `wb`. `wbMessages` — сообщения `wb` над заданным
 * внешним вызова: тест строки `ts/` (W14) собирает их над заглушками
 * стенда.
 */

export { ozonCommands } from "./src/ozon.ts";
export { ozonPerfCommands } from "./src/ozonPerf.ts";
export { wbCommands, wbMessages } from "./src/wb.ts";
