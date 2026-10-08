import type { Data, Outcome, Report } from "@mpu/language/objects";
import type { Change, RulePath } from "@mpu/command/policy";
import type { Order } from "./order.ts";
import type { View } from "./view.ts";

/**
 * Строка вызова глазами дерева: что узел в конце строки просит у неё
 * сделать. Решают ли правила и спрашивать ли человека — дело строки.
 */
export interface Line {
  /**
   * Исполнить строку нынешней диспетчеризацией, пришедшую взглядом
   * `view`; строку ей собирает `order` листа.
   */
  dispatch(report: Report, view: View, order: Order): Promise<Outcome>;
  /** stdin строки — терминал: ключ ввода команда спросит сама. */
  terminal(): boolean;
  /** Результат строки — поток: отбору не подлежит. */
  streams(view: View, order: Order): boolean;
  /**
   * Исполнить строку, как `dispatch`, но результат не печатать, а отдать
   * данными отбору `replay`; код завершения — код команды.
   */
  select(
    report: Report,
    view: View,
    order: Order,
    replay: (data: Data) => Promise<Outcome>,
  ): Promise<Outcome>;
  /** Отдать правила данными. */
  listRules(report: Report): Promise<Outcome>;
  /** Изменить правило на пути `path`. */
  change(report: Report, path: RulePath, change: Change): Promise<Outcome>;
  /**
   * Решение правил пути строки у взгляда `view` — вопрос, отказ или
   * согласие; исполнения нет: ответ строки-хука даёт сам хук (`hook.ts`).
   */
  consent(report: Report, view: View): Promise<Outcome>;
}
