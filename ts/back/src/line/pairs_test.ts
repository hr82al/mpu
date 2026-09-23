/**
 * Пара разбора (`platform/keys-translation.md`, «Проверка полноты и
 * пара»): у каждой ключевой команды прежняя строка и новая, набранная
 * ключами из каталога, дают один и тот же вход команды — объект
 * аргументов с умолчаниями. Новая строка идёт через цепочку до строки,
 * которую получила бы прежняя диспетчеризация; исполнения нет.
 */

import { assertEquals, assertObjectMatch } from "@std/assert";
import type { Command, InputSpec } from "../command/mod.ts";
import { shellCommand } from "../exec/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { type Outcome, type Report, runChain } from "../objects/mod.ts";
import { RuleBook } from "../policy/mod.ts";
import { isProgram } from "../program/mod.ts";
import { commands, findCommand } from "../registry/mod.ts";
import type { Line } from "./dispatch.ts";
import { addressesOf } from "./keyed.ts";
import { programCommands } from "./program.ts";
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

  consent(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }

  streams(): boolean {
    return false;
  }

  terminal(): boolean {
    return false;
  }

  select(report: Report): Promise<Outcome> {
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

/**
 * Прежний флаг варианта и его слово: у булева входа с умолчанием `true`
 * флаг — `--no-<вход>`, у выбора — `--<вход> <первое значение>`
 * (`platform/variants.md`).
 */
function variantPair(
  command: Command,
  input: InputSpec,
  address: string,
): { readonly before: readonly string[]; readonly word: string } | undefined {
  const [kind, ...names] = address.split(" ");
  const first = names[0]?.replace(",", "");
  if (kind === "варианты") {
    return { before: [`--${input.name}`, first], word: first };
  }
  if (kind !== "вариант") return undefined;
  const field = command.argsJsonSchema.properties[input.name];
  const flag = field.default === true ? `no-${input.name}` : input.name;
  return { before: [`--${flag}`], word: first };
}

/**
 * Прежняя строка и новая для всех входов, у которых есть ключ или
 * вариант: слова вариантов — до ключей.
 */
function lines(command: Command, addresses: ReadonlyMap<string, string>) {
  const before: string[] = [];
  const positional: string[] = [];
  const variants: string[] = [];
  const after: string[] = [];
  for (const input of command.inputs) {
    // Ключ пишется одним словом: `id:` или `--флаг`; вариант — словом до
    // ключей; прочие адреса — формат, снятый вход, прежнее написание — в
    // строках не участвуют.
    const address = addresses.get(input.name) ?? " ";
    const variant = variantPair(command, input, address);
    if (variant !== undefined) {
      before.push(...variant.before);
      variants.push(variant.word);
      continue;
    }
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
  return {
    before: [...before, "--", ...positional],
    after: [...variants, ...after],
  };
}

/**
 * Вход команды из строки прежней диспетчеризации: слова пути вырезаются
 * там, где стоят, — у группы с селектором впереди имя подкоманды идёт за
 * позиционными.
 */
function argsOf(command: Command, argv: readonly string[]): string[] {
  const words = [...argv];
  for (const word of command.path) words.splice(words.indexOf(word), 1);
  return words;
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
      : command.parseArgs(argsOf(command, line.argv)),
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
  [["logs", "ls"], ["logs", "hosts"]],
  [["logs", "sl-1", "ls"], ["logs", "services", "target:", "sl-1"]],
  [["move-client-back", "rm", "1234"], [
    "move-client-back",
    "rm",
    "target:",
    "1234",
  ]],
  [["move-client-back", "ls"], ["move-client-back", "ls"]],
  [["move-client-back", "1234"], ["move-client-back", "target:", "1234"]],
  [["api", "get-client-module", "54", "wb"], [
    "api",
    "get-client-module",
    "client:",
    "54",
    "id:",
    "wb",
  ]],
  // `cmd:` — одно слово: прежняя пара — команда одним словом; что
  // разбитая на слова она даёт ту же строку шелла, проверяет тест ниже.
  [["ssh", "sl-1", "ls -la"], ["ssh", "target:", "sl-1", "cmd:", "ls -la"]],
  [["run-js", "sl-1", "1+1", "-d"], [
    "run-js",
    "detach",
    "target:",
    "sl-1",
    "text:",
    "1+1",
  ]],
  [["process", "54", "--dry-run"], ["process", "dry", "target:", "54"]],
  [["logs", "--via", "portainer", "sl-1"], [
    "logs",
    "portainer",
    "target:",
    "sl-1",
  ]],
  [["kiten", "card", "1", "--no-comments"], [
    "kiten",
    "card",
    "no-comments",
    "id:",
    "1",
  ]],
  [["ps", "--tsv"], ["ps", GRAMMAR.close, "tsv"]],
  [["confirm", "-y", "-m", "да?"], ["confirm", "yes", "text:", "да?"]],
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
        if (command === undefined) throw new Error(`нет команды ${before}`);
        assertEquals(
          command.parseArgs(argsOf(command, line.argv)),
          command.parseArgs(argsOf(command, before)),
        );
      });
    }
  }));

Deno.test("ssh: cmd одним словом — та же строка шелла, что и по словам", () => {
  assertEquals(shellCommand(["ls -la"]), shellCommand(["ls", "-la"]));
});

/**
 * Слова строки, как их отдаст оболочка: одинарные кавычки держат всё
 * буквально (`'"'"'` — кавычка внутри, как пишет `quoteArg`), двойные —
 * тоже, для простоты; here-doc (`<<`) и дальше — не аргументы.
 */
function pasted(line: string): string[] {
  const words: string[] = [];
  const head = line.split(" <<")[0];
  for (const match of head.matchAll(/(?:'[^']*'|"[^"]*"|[^\s'"]+)+/g)) {
    const word = match[0].replace(/'([^']*)'|"([^"]*)"/g, "$1$2");
    words.push(word);
  }
  return words.slice(words.indexOf("mpu") + 1);
}

/** Строка `mpu`, собранная из напечатанного, — argv прежней диспетчеризации. */
async function argvOf(file: string, words: readonly string[]) {
  using book = RuleBook.open(file, registrySeeds());
  const line = new Captured();
  const outcome = await runChain(words, registryRoot(line, book));
  assertEquals("exit" in outcome, true, JSON.stringify(outcome));
  return line.argv;
}

Deno.test("напечатанные строки вставляются: тот же вход ssh", (t) =>
  withPolicyFile(async (file) => {
    const ssh = commands.find((one) => one.path.join(" ") === "ssh");
    if (ssh === undefined) throw new Error("нет ssh");
    const cases = [
      [
        "../nodecli/testdata/portainer-wrappers/process-dev-print.stdout.txt",
        "dev:1",
        "node cli service:dataProcessor process --client-id 777 --dataset wb_unit",
      ],
      [
        "../runjs/testdata/run-js/dry-run-stdout.txt",
        "sl-0",
        "node --input-type=module -",
      ],
    ] as const;
    for (const [golden, target, command] of cases) {
      await t.step(golden, async () => {
        const url = new URL(golden, import.meta.url);
        const printed = (await Deno.readTextFile(url)).split("\n")[0];
        // Вход ssh — объект разбора его схемы; поля те, что она объявляет.
        const args = ssh.parseArgs(
          argsOf(ssh, await argvOf(file, pasted(printed))),
        ) as { selector: string; command: [string, ...string[]] };
        assertEquals(args.selector, target);
        assertEquals(shellCommand(args.command), command);
      });
    }
  }));

Deno.test("подсказки run-js --detach вставляются: тот же вход", (t) =>
  withPolicyFile(async (file) => {
    const log = "/tmp/mpu-run-js-x.log";
    const reader = `import fs from "node:fs"; process.stdout.write(` +
      `fs.existsSync("${log}") ? fs.readFileSync("${log}","utf8") : ` +
      `"no log yet\\n")`;
    // Строки — те, что печатает run.ts (их дословно сверяет
    // cmd_run_js_test.ts, «--detach … подсказки»); пара — прежняя запись
    // той же строки.
    const cases = [
      [
        `# собрать логи: mpu run-js all text: '${reader}'`,
        ["run-js", "--all", reader],
      ],
      [
        `# или вживую: mpu ssh target: sl-1 cmd: 'tail -f ${log}'`,
        ["ssh", "sl-1", `tail -f ${log}`],
      ],
    ] as const;
    for (const [printed, before] of cases) {
      await t.step(before[0], async () => {
        const command = commands.find((one) => one.path[0] === before[0]);
        if (command === undefined) throw new Error(`нет ${before[0]}`);
        assertEquals(
          command.parseArgs(
            argsOf(command, await argvOf(file, pasted(printed))),
          ),
          command.parseArgs(before.slice(1)),
        );
      });
    }
  }));

Deno.test("ключ-текст: слово MCP как есть доходит до входа команды", (t) =>
  withPolicyFile(async (file) => {
    const cases: readonly (readonly [
      readonly string[],
      Readonly<Record<string, unknown>>,
    ])[] = [
      [
        [
          "telegram",
          "send",
          "chat:",
          "@kalabass",
          "text:",
          "@kalabass Иван, итог: всё готово.",
        ],
        { chat: "@kalabass", message: "@kalabass Иван, итог: всё готово." },
      ],
      [["telegram", "send", "chat:", "me", "text:", "."], { message: "." }],
      [["telegram", "search", "query:", "@ivan"], { query: "@ivan" }],
      [
        ["kiten", "comment", "id:", "5", "to:", "@petr", "text:", "@ivan ок."],
        { selector: "5", to: ["@petr"], message: "@ivan ок." },
      ],
    ];
    for (const [words, input] of cases) {
      await t.step(words.join(" "), async () => {
        assertEquals(isProgram(words, programCommands()), false);
        const command = findCommand(words.slice(0, 2));
        if (command === undefined) throw new Error("нет команды");
        const argv = await argvOf(file, words);
        assertObjectMatch(command.parseArgs(argsOf(command, argv)), input);
      });
    }
  }));
