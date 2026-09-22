/**
 * Пара разбора (`platform/keys-translation.md`, «Проверка полноты и
 * пара»): у каждой ключевой команды прежняя строка и новая, набранная
 * ключами из каталога, дают один и тот же вход команды — объект
 * аргументов с умолчаниями. Новая строка идёт через цепочку до строки,
 * которую получила бы прежняя диспетчеризация; исполнения нет.
 */

import { assertEquals } from "@std/assert";
import type { Command, InputSpec } from "../command/mod.ts";
import { type Outcome, type Report, runChain } from "../objects/mod.ts";
import { RuleBook } from "../policy/mod.ts";
import { commands } from "../registry/mod.ts";
import type { Line } from "./dispatch.ts";
import { addressesOf } from "./keyed.ts";
import type { Order } from "./order.ts";
import { registrySeeds } from "./seeds.ts";
import { withPolicyFile } from "./testconsent.ts";
import { formatsOf, registryRoot } from "./tree.ts";

/** Строка, которую получила бы прежняя диспетчеризация; исполнения нет. */
class Captured implements Line {
  argv: readonly string[] = [];

  dispatch(report: Report, _view: unknown, order: Order): Promise<Outcome> {
    this.argv = order.argv([]);
    return Promise.resolve(report.exit(0));
  }

  listRules(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }

  change(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }
}

/** Пробное значение входа: то, что схема примет. */
function sample(command: Command, input: InputSpec): readonly string[] {
  const field = command.argsJsonSchema.properties[input.name];
  const allowed = field.enum?.[0];
  if (allowed !== undefined) return [String(allowed)];
  if (input.kind === "number" || input.kind === "numbers") return ["7", "8"];
  return [`v-${input.name}`, `w-${input.name}`];
}

/** Одно значение или список — по виду входа. */
function many(input: InputSpec): boolean {
  return input.kind === "strings" || input.kind === "numbers" ||
    input.form.positional === "rest";
}

/** Прежняя строка и новая для всех входов, у которых есть ключ. */
function lines(command: Command, addresses: ReadonlyMap<string, string>) {
  const before: string[] = [];
  const positional: string[] = [];
  const after: string[] = [];
  for (const input of command.inputs) {
    // Ключ пишется одним словом: `id:` или `--флаг`; прочие адреса —
    // формат, снятый вход, прежнее написание — в строках не участвуют.
    const address = addresses.get(input.name) ?? " ";
    if (address.includes(" ")) continue;
    if (address.startsWith("--")) {
      // Флаг: прежняя строка и новая пишут одно и то же слово.
      before.push(address);
      after.push(address);
      continue;
    }
    const values = many(input)
      ? sample(command, input)
      : sample(command, input).slice(0, 1);
    for (const value of values) after.push(address, value);
    if (input.form.positional !== undefined) positional.push(...values);
    else for (const value of values) before.push(`--${input.name}`, value);
  }
  return { before: [...before, "--", ...positional], after };
}

async function pairOf(file: string, command: Command) {
  const addresses = addressesOf(
    command,
    Object.keys(formatsOf(command.path)),
  );
  const { before, after } = lines(command, addresses);
  using book = RuleBook.open(file, registrySeeds());
  const line = new Captured();
  const outcome = await runChain(
    [...command.path, ...after],
    registryRoot(line, book),
  );
  return {
    outcome,
    before: command.parseArgs(before),
    after: line.argv.length === 0
      ? outcome
      : command.parseArgs(line.argv.slice(command.path.length)),
  };
}

Deno.test("прежняя строка и ключи дают один вход команды", (t) =>
  withPolicyFile(async (file) => {
    for (const command of commands.filter((one) => one.keys !== undefined)) {
      await t.step(command.path.join(" "), async () => {
        const pair = await pairOf(file, command);
        assertEquals(
          "exit" in pair.outcome,
          true,
          JSON.stringify(pair.outcome),
        );
        assertEquals(pair.after, pair.before);
      });
    }
  }));

/** Поимённые пары из граничных случаев спеки: прежняя строка и новая. */
const NAMED: readonly (readonly [readonly string[], readonly string[]])[] = [
  [
    ["mr", "comment", "src/a.ts:10", "--mr", "5", "-m", "см. тут"],
    ["mr", "comment", "id:", "5", "at:", "src/a.ts:10", "text:", "см. тут"],
  ],
  [["mr", "show", "abcdef12"], ["mr", "show", "id:", "abcdef12"]],
  [["kiten", "card", "1"], ["kiten", "card", "id:", "1"]],
];

Deno.test("поимённые пары спеки дают один вход команды", (t) =>
  withPolicyFile(async (file) => {
    for (const [before, after] of NAMED) {
      await t.step(after.join(" "), async () => {
        using book = RuleBook.open(file, registrySeeds());
        const line = new Captured();
        await runChain(after, registryRoot(line, book));
        const command = commands.find((one) =>
          one.path.every((word, i) => before[i] === word)
        );
        const size = command?.path.length ?? 0;
        assertEquals(
          command?.parseArgs(line.argv.slice(size)),
          command?.parseArgs(before.slice(size)),
        );
      });
    }
  }));
