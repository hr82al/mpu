/**
 * Семейство копирований: клиент с прода, справочники `shared` и данные
 * с dev-стенда (`copy-client.md`, `copy-shared.md`, `copy-dev.md`).
 *
 * Наружу идут только команды; подключения, запуск инструментов и
 * перенос строк — внутренности семейства. Машинерия копии клиента
 * общая у `copy-client` и `copy-dev` (`client_copy.ts`): порядок шагов
 * и счётчики — контракт, и двум копиям кода разъезжаться в нём нельзя.
 */

export { copyClientCommand } from "./cmd_copy_client.ts";
export { copyDevCommand } from "./cmd_copy_dev.ts";
export { copySharedCommand } from "./cmd_copy_shared.ts";
