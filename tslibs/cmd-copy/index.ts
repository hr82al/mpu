/**
 * Семейство копирований: клиент с прода, справочники `shared` и данные
 * с dev-стенда (`copy-client.md`, `copy-shared.md`, `copy-dev.md`).
 *
 * Наружу идут команды и наборы таблиц клиента — их берёт очистка
 * локальных клиентов (`clean-local-clients.md`): она убирает ровно то,
 * что завела копия, и второй список разъехался бы с первым.
 * Подключения, запуск инструментов и перенос строк — внутренности
 * семейства. Машинерия копии клиента общая у `copy-client` и `copy-dev`
 * (`client_copy.ts`): порядок шагов и счётчики — контракт, и двум копиям
 * кода разъезжаться в нём нельзя.
 */

export { copyClientCommand } from "./src/cmd_copy_client.ts";
export { copyDevCommand } from "./src/cmd_copy_dev.ts";
export { copySharedCommand } from "./src/cmd_copy_shared.ts";
export {
  SL0_CLIENT_TABLES,
  SL1_CLIENT_TABLES,
  SPREADSHEET_CHILDREN,
} from "./src/rows.ts";
