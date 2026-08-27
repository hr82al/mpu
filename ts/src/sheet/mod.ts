/**
 * Чтение Google-таблиц (`docs/specs/sheet.md`): диапазоны, листы и
 * диагностика резолва цели.
 *
 * Наружу модуль отдаёт только команды реестра; транспорт webapp, кэш
 * листов и разбор A1 остаются внутренностями (`platform/webapp-http.md`).
 */

export { sheetGetCommand } from "./cmd_get.ts";
export { sheetLsCommand } from "./cmd_ls.ts";
export { sheetResolveCommand } from "./cmd_resolve.ts";
