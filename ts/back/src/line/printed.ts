/**
 * Итог цепочки в поток и код (данные границы): его печатают конец
 * строки и отбор, у которого код — код исполненной команды.
 */

import type { Output } from "../entrypoint/mod.ts";
import type { Outcome, Told } from "../objects/mod.ts";

/** Вывод строки, которому отказ говорит и объектом, и текстом. */
export type Speech = Output & Told;

/** Печатает итог и отдаёт код завершения. */
export function printed(outcome: Outcome, output: Speech): number {
  if ("refused" in outcome) {
    outcome.refused.tell(output);
    return 2;
  }
  if ("exit" in outcome) return outcome.exit;
  if ("object" in outcome) {
    output.stdout(outcome.object);
    return 2;
  }
  output.stdout(textOf(outcome.value));
  return 0;
}

/**
 * Данные итога текстом: справка — строка как есть; ответы `selectors` и
 * `respondsTo:` — JSON (формы их печати спека не задаёт).
 */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  return `${JSON.stringify(value)}\n`;
}
