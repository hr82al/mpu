/**
 * Посев правил из реестра (`platform/policy.md`, «Посев»): признак
 * `ro`/`rw` команды читается только здесь и только один раз — дальше
 * источник решения правило в файле.
 */

import type { Command, Policy } from "../command/mod.ts";
import {
  ELICITATION,
  NOTIFICATION,
  PERMISSION_REQUEST,
  STOP,
} from "../frames/mod.ts";
import { EXPORT_PATH } from "../image/mod.ts";
import {
  ALLOW,
  ASK,
  Migration,
  Rule,
  RuleBook,
  RulePath,
  type Verdict,
} from "../policy/mod.ts";
import { type CommandGroup, commands, groups } from "../registry/mod.ts";
import { HISTORY_CLEAR_PATH } from "../task/mod.ts";

/** Путь сообщения корня `policy` — его посев `allow`. */
export const POLICY_SELECTOR = "policy";

/**
 * Поверхности, которые только читают: `version` и `help` — выражением
 * программы `help` доходит до обхода правил поверхностью.
 */
const READ_ONLY_SURFACES: readonly string[] = ["version", "help"];

const SEED_OF: Readonly<Record<Policy, Verdict>> = { ro: ALLOW, rw: ASK };

/**
 * Команды, чей посев — не по признаку `ro`/`rw` (`platform/policy.md`,
 * «Посев»): решение отсюда заменяет посев по признаку, а не встаёт рядом —
 * второе правило того же пути уронило бы посев целиком. `image export`
 * пишет только файлы каталога образа (`image-export.md`); записи ролей
 * канала `task` и его журнал — только локальный журнал (`task.md`);
 * отметки ролей ставит сама роль без человека (`task-roles.md`); стоп
 * проекта ставит хост на блокере (`task-orchestrator.md`); хук
 * `PermissionRequest` зовёт Claude Code без человека, и `ask` значил бы
 * «спросить некого» на каждом вызове (`claude-hook-permission-request.md`
 * [D.2]); хуки `Stop`, `Notification` и `Elicitation` — то же (`platform/policy.md`,
 * «Посев»).
 */
const OWN_SEEDS: ReadonlyMap<string, Verdict> = new Map([
  [EXPORT_PATH.join(" "), ALLOW],
  [PERMISSION_REQUEST.words.join(" "), ALLOW],
  [STOP.words.join(" "), ALLOW],
  [NOTIFICATION.words.join(" "), ALLOW],
  [ELICITATION.words.join(" "), ALLOW],
  ...[
    "post",
    "report",
    "question",
    "answer",
    "decision",
    "owner",
    "history",
    "busy",
    "idle",
    "stop",
  ].map((name): [string, Verdict] => [`task ${name}`, ALLOW]),
]);

/**
 * Посев команды: своё решение из `OWN_SEEDS` или по признаку; у команды,
 * которую пишет только человек, посева нет.
 */
function commandSeeds(command: Command): readonly Rule[] {
  const own = OWN_SEEDS.get(command.path.join(" "));
  return command.gate.pick({
    rules: () => [ruleAt(command.path, own ?? SEED_OF[command.policy])],
    owner: () => [],
  });
}

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
    ...commands.flatMap(commandSeeds),
    // Режим — звено пути правила, а посев команд знает только их пути:
    // чистка журнала канала спрашивает (`task.md`, «Правила»).
    ruleAt(HISTORY_CLEAR_PATH, ASK),
    ...groups.flatMap(groupSeeds),
    ...READ_ONLY_SURFACES.map((name) => ruleAt([name], ALLOW)),
    ruleAt([POLICY_SELECTOR], ALLOW),
  ];
}

/**
 * Разовые миграции посеянных правил (`platform/policy.md`, «Посев»):
 * хук `Notification` прежние версии сеяли по признаку `rw` — `ask`, и
 * строка хука отбивалась «спросить некого». Имя — отметка выполненной
 * миграции в файле правил: не менять (новое имя — миграция заново,
 * поверх правила, поставленного человеком) и не повторять.
 */
export function registryMigrations(): Migration[] {
  return [
    new Migration(
      "R4: claude-hook notification ask → allow",
      RulePath.parse(NOTIFICATION.words.join(" ")),
      ASK,
      ALLOW,
    ),
  ];
}

/**
 * Книга правил реестра: посев и миграции реестра — одним местом, чтобы
 * ни одно рабочее открытие не забыло миграции.
 *
 * @throws PolicyError — файл нельзя открыть или прочитать
 */
export function openRegistryBook(file: string | undefined): RuleBook {
  return RuleBook.open(file, registrySeeds(), registryMigrations());
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
