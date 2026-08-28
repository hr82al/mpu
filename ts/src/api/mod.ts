/**
 * Неймспейс `mpu api`: тонкие обёртки админских эндпоинтов sl-back
 * (`docs/specs/api.md`). Наружу модуль отдаёт только список команд —
 * таблица эндпоинтов и фабрика остаются внутренностями.
 *
 * Половина семейства читающая; пишущая едет следующей поставкой, и до
 * неё имя группы остаётся в слепке маршрута `legacy`: неизвестная
 * подкоманда уходит прежней реализации, как это было у `kiten` и
 * `telegram`.
 */

import type { Command } from "../command/mod.ts";
import { endpointCommand } from "./command.ts";
import { READ_ENDPOINTS } from "./endpoints.ts";
import { apiGetTokenCommand } from "./cmd_get_token.ts";

/**
 * Читающие команды группы в алфавитном порядке имени: `mpu api --help`
 * перечисляет их одной строкой на команду, и порядок таблицы (сперва
 * `get-*`, потом `list-*`) от алфавитного не отличается — кроме
 * `get-token`, которому иначе пришлось бы стоять в конце.
 */
export const apiCommands: readonly Command[] = [
  ...READ_ENDPOINTS.map(endpointCommand),
  apiGetTokenCommand,
].sort((a, b) => a.path[1] < b.path[1] ? -1 : a.path[1] > b.path[1] ? 1 : 0);
