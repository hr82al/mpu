/**
 * Посев правил из реестра (`platform/policy.md`, «Посев»): признак
 * `ro`/`rw` команды читается только здесь и только один раз — дальше
 * источник решения правило в файле.
 */

import type { Command, Policy } from "../command/mod.ts";
import { ALLOW, ASK, Rule, RulePath, type Verdict } from "../policy/mod.ts";
import { type CommandGroup, commands, groups } from "../registry/mod.ts";

/** Путь сообщения корня `policy` — его посев `allow`. */
export const POLICY_SELECTOR = "policy";

/**
 * Поверхности, которые только читают: `version` и `help` — выражением
 * программы `help` доходит до обхода правил поверхностью.
 */
const READ_ONLY_SURFACES: readonly string[] = ["version", "help"];

const SEED_OF: Readonly<Record<Policy, Verdict>> = { ro: ALLOW, rw: ASK };

function under(group: CommandGroup): readonly Command[] {
  return commands.filter((command) =>
    group.path.every((segment, i) => command.path[i] === segment) &&
    command.path.length > group.path.length
  );
}

function ruleAt(path: readonly string[], verdict: Verdict): Rule {
  return new Rule(RulePath.parse(path.join(" ")), verdict);
}

/**
 * Посев группы: селектор перед подкомандой — самое строгое из посевных
 * решений детей; прочие группы правила не получают — их путь до
 * исполнения не доходит.
 */
function groupSeeds(group: CommandGroup): Rule[] {
  if (group.layout !== "selector-first") return [];
  const writes = under(group).some((command) => command.policy === "rw");
  return [ruleAt(group.path, writes ? ASK : ALLOW)];
}

/** Посевные правила всего реестра. */
export function registrySeeds(): Rule[] {
  return [
    ...commands.map((command) => ruleAt(command.path, SEED_OF[command.policy])),
    ...groups.flatMap(groupSeeds),
    ...READ_ONLY_SURFACES.map((name) => ruleAt([name], ALLOW)),
    ruleAt([POLICY_SELECTOR], ALLOW),
  ];
}

/**
 * Пишущие подкоманды, которые правило на группе с селектором перед
 * подкомандой откроет вызову с селектором впереди; прочим путям — пусто.
 */
export function selectorFirstWriters(path: RulePath): readonly string[] {
  const group = groups.find((one) =>
    one.layout === "selector-first" && one.path.join(" ") === path.text()
  );
  if (group === undefined) return [];
  return under(group)
    .filter((command) => command.policy === "rw")
    .map((command) => command.path.slice(group.path.length).join(" "));
}
