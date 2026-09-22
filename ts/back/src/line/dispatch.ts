import type { Outcome, Report } from "../objects/mod.ts";
import type { Change, RulePath } from "../policy/mod.ts";

/**
 * Строка вызова глазами дерева: что узел в конце строки просит у неё
 * сделать. Решают ли правила и спрашивать ли человека — дело строки.
 */
export interface Line {
  /** Исполнить строку нынешней диспетчеризацией. */
  dispatch(report: Report): Promise<Outcome>;
  /** Отдать правила данными. */
  listRules(report: Report): Promise<Outcome>;
  /** Изменить правило на пути `path`. */
  change(report: Report, path: RulePath, change: Change): Promise<Outcome>;
}
