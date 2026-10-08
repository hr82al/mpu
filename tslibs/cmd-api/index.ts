/**
 * Неймспейс `mpu api`: тонкие обёртки админских эндпоинтов sl-back
 * (`docs/specs/api.md`). Наружу — список команд (реестр), таблица
 * пишущих эндпоинтов с разбором пути (сверка контракта реестра `ts/`) и
 * голдены состава колонок со сверкой (smoke `ts/`); фабрика команды и
 * адрес sl-back остаются внутренностями.
 */

import type { Command } from "@mpu/command";
import { endpointCommand } from "./src/command.ts";
import { READ_ENDPOINTS } from "./src/endpoints.ts";
import { WRITE_ENDPOINTS } from "./src/endpoints_write.ts";
import { apiGetTokenCommand } from "./src/cmd_get_token.ts";
import { ssAccessCommands } from "./src/cmd_ss_access.ts";
import { wbCardsResetCommand } from "./src/cmd_wb_cards_reset.ts";
import { wbLoaderCommands } from "./src/cmd_wb_loader.ts";

/**
 * Читающие команды группы в алфавитном порядке имени: `mpu api --help`
 * перечисляет их одной строкой на команду, и порядок таблицы (сперва
 * `get-*`, потом `list-*`) от алфавитного не отличается — кроме
 * `get-token`, которому иначе пришлось бы стоять в конце.
 */
export const apiCommands: readonly Command[] = [
  ...READ_ENDPOINTS.map(endpointCommand),
  ...WRITE_ENDPOINTS.map(endpointCommand),
  apiGetTokenCommand,
  // Кастомная группа: четыре команды третьего уровня
  // (`docs/specs/api-ss-access.md`). Сортировка по второму сегменту
  // ставит их подряд — у всех он `ss-access`.
  ...ssAccessCommands,
  // Вторая кастомная группа: одна команда с резолвом селектора до sid
  // (`docs/specs/api-wb-cards-reset.md`).
  wbCardsResetCommand,
  // Третья кастомная группа: шесть команд управления загрузчиками
  // (`docs/specs/api-wb-loader.md`). С ней `api` уходит с легаси.
  ...wbLoaderCommands,
].sort((a, b) => (a.path[1] < b.path[1] ? -1 : a.path[1] > b.path[1] ? 1 : 0));

export { type FieldSpec, pathParams } from "./src/endpoint.ts";
export { WRITE_ENDPOINTS } from "./src/endpoints_write.ts";
export {
  compareColumns,
  schemaCheckPlan,
  schemaGoldens,
  skipReason,
} from "./src/schema_golden.ts";
