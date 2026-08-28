/**
 * Чтение Google-таблиц (`docs/specs/sheet.md`): диапазоны, листы и
 * диагностика резолва цели.
 *
 * Наружу модуль отдаёт только команды реестра; транспорт webapp, кэш
 * листов и разбор A1 остаются внутренностями (`platform/webapp-http.md`).
 */

export {
  sheetAliasAddCommand,
  sheetAliasLsCommand,
  sheetAliasRmCommand,
} from "./cmd_alias.ts";
export { sheetBatchGetCommand } from "./cmd_batch_get.ts";
export { sheetBatchUpdateCommand } from "./cmd_batch_update.ts";
export { sheetCacheClearCommand, sheetCacheInfoCommand } from "./cmd_cache.ts";
export { sheetGetCommand } from "./cmd_get.ts";
export { sheetLsCommand } from "./cmd_ls.ts";
export { sheetOpenCommand } from "./cmd_open.ts";
export { sheetResolveCommand } from "./cmd_resolve.ts";
