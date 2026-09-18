/**
 * Правила подтверждения (`docs/specs/platform/policy.md`): решение
 * «выполнить / спросить / отказать» для пути строки, файл правил с
 * посевом и канал, у которого спрашивают.
 */

export { PolicyError, RuleBook } from "./book.ts";
export { Agent, type Channel, Human, NOBODY, type Reply } from "./channel.ts";
export { EmptyRulePath, RulePath } from "./path.ts";
export { INHERITED, Rule, Rules, type Ruling } from "./rules.ts";
export {
  ALLOW,
  ASK,
  type Change,
  DENY,
  type Execution,
  FORGET,
  type RuleEntry,
  type Verdict,
  type Writers,
} from "./verdict.ts";
