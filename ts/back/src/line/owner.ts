/**
 * Путь, который пишет только человек (`task.md`, «Правила»), в обходе
 * программы: правилами он не решается, вопрос задаст исполнение строки
 * (`Session`), поэтому обход его пропускает, не требуя двери.
 */

import { RULES_GATE } from "../command/mod.ts";
import { ARGS } from "./tree.ts";
import type { RuleBook, Ruling } from "../policy/mod.ts";
import { findCommand } from "../registry/mod.ts";

/** Решение обхода «спросит исполнение»: строка допускается дальше. */
const AT_EXECUTION: Ruling = {
  settle: (execution) => execution.run(),
  admits: () => true,
  record: () => ({ verdict: "owner", won: null }),
  yieldsTo: () => false,
};

/** Решение обхода для звеньев `links`: правила или «спросит исполнение». */
export function aheadRuling(book: RuleBook, links: readonly string[]): Ruling {
  const path = links.filter((link) => link !== ARGS);
  const gate = findCommand(path)?.gate ?? RULES_GATE;
  return gate.pick({
    rules: () => book.decide(links),
    owner: () => AT_EXECUTION,
  });
}
