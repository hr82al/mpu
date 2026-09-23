/**
 * Справки всех команд в новой форме (`platform/keys-translation.md`,
 * «Проверка полноты и пара», «Справки»): примеры — полем `examples`, и
 * каждый проходит строкой до исполнения без отказа; в тексте справки и в
 * строке использования нет снятых написаний — коротких флагов, флагов
 * формата, snake_case и прежних имён переименованных входов.
 */

import { assert, assertEquals } from "@std/assert";
import type { Command } from "../command/mod.ts";
import { type Outcome, type Report, runChain } from "../objects/mod.ts";
import { RuleBook } from "../policy/mod.ts";
import { commands } from "../registry/mod.ts";
import type { Line } from "./dispatch.ts";
import { addressesOf } from "./keyed.ts";
import { registrySeeds } from "./seeds.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import { formatsOf, registryRoot } from "./tree.ts";

/** Строка доходит до исполнения; самого исполнения нет. */
class Captured implements Line {
  dispatch(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }

  listRules(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }

  change(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }
}

/** Слова примера, как их разберёт оболочка: кавычки держат пробелы. */
function shellWords(example: string): string[] {
  const words: string[] = [];
  for (const match of example.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

/** Слова строки `mpu` в примере: после `mpu`, до конца или до `|`. */
function lineOf(example: string): string[] {
  const words = shellWords(example);
  const start = words.indexOf("mpu") + 1;
  const end = words.indexOf("|", start);
  return words.slice(start, end < 0 ? undefined : end);
}

/** Написания, которых в новой записи нет, — по входам команды. */
function stale(command: Command): string[] {
  const addresses = addressesOf(command, Object.keys(formatsOf(command.path)));
  const words = Object.values(formatsOf(command.path)).flat()
    .filter((word) => word.startsWith("-"));
  for (const input of command.inputs) {
    if (input.form.short !== undefined) words.push(`-${input.form.short}`);
    if (input.name.includes("_")) words.push(`--${input.name}`);
    const address = addresses.get(input.name) ?? "";
    const dashed = input.name.replaceAll("_", "-");
    const renamed = input.form.positional === undefined &&
      address.endsWith(":") && !address.includes(" ") &&
      address !== `${dashed}:`;
    if (renamed) words.push(`--${dashed}`);
  }
  return words;
}

/** Слово-написание стоит в тексте отдельным словом. */
function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s(\\[/,;|'"\`])${escaped}(?=$|[\\s)\\]/,;.:|'"\`=])`)
    .test(text);
}

Deno.test("справки: примеры полем, без снятых написаний", async (t) => {
  for (const command of commands) {
    await t.step(command.path.join(" "), () => {
      assert(command.examples.length > 0, "нет примеров");
      assert(!/Примеры?:/.test(command.help), "примеры в тексте справки");
      const addresses = addressesOf(
        command,
        Object.keys(formatsOf(command.path)),
      );
      // Прежние позиционные значения — ключи, и строка использования
      // называет каждый: заглушка без ключа учит голому значению.
      const unnamed = command.inputs
        .filter((input) => input.form.positional !== undefined)
        .map((input) => addresses.get(input.name) ?? "")
        .filter((address) => !address.includes(" "))
        .filter((address) => !command.usage.includes(address));
      assertEquals(unnamed, [], "позиционный вход без ключа в строке");
      // Описания входов — строки раздела «Ключи» и схемы тула.
      const fields = Object.entries(command.argsJsonSchema.properties)
        .filter(([name]) => !(addresses.get(name) ?? "").startsWith("формат"))
        .map(([, field]) => field.description ?? "");
      const text = [command.summary, command.usage, command.help, ...fields]
        .join("\n");
      const found = stale(command).filter((word) => mentions(text, word));
      assertEquals(found, [], "снятые написания в справке");
    });
  }
});

Deno.test("справки: каждый пример доходит до исполнения", (t) =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    for (const command of commands) {
      for (const example of command.examples) {
        await t.step(example, async () => {
          using book = RuleBook.open(file, registrySeeds());
          const outcome = await runChain(
            lineOf(example),
            registryRoot(new Captured(), book),
          );
          assertEquals(
            "exit" in outcome && outcome.exit,
            0,
            JSON.stringify(outcome),
          );
        });
      }
    }
  }));
