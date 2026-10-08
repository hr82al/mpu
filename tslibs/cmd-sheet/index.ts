/**
 * Чтение Google-таблиц (`docs/specs/sheet.md`): диапазоны, листы и
 * диагностика резолва цели.
 *
 * Наружу пакет отдаёт команды реестра и ключи `mpu config` семейства
 * (их собирает в список приложение, `platform/config.md`); транспорт
 * webapp, кэш листов и разбор A1 остаются внутренностями
 * (`platform/webapp-http.md`).
 */

export {
  sheetAliasAddCommand,
  sheetAliasLsCommand,
  sheetAliasRmCommand,
} from "./src/cmd_alias.ts";
export { sheetBatchGetCommand } from "./src/cmd_batch_get.ts";
export { sheetBatchUpdateCommand } from "./src/cmd_batch_update.ts";
export {
  sheetCacheClearCommand,
  sheetCacheInfoCommand,
} from "./src/cmd_cache.ts";
export { sheetGetCommand } from "./src/cmd_get.ts";
export { sheetLsCommand } from "./src/cmd_ls.ts";
export { sheetOpenCommand } from "./src/cmd_open.ts";
export { sheetResolveCommand } from "./src/cmd_resolve.ts";
export { sheetSetCommand } from "./src/cmd_set.ts";
export {
  SHEET_CACHE_MAX_TAB_BYTES,
  SHEET_CACHE_MAX_TOTAL_MB,
  SHEET_CACHE_TAB_TTL,
  SHEET_DEFAULT,
} from "./src/settings.ts";
