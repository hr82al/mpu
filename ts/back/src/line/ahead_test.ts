/**
 * Итог обхода (`platform/ask-composite.md`, «Обход до исполнения»): запрет
 * старше записи без двери, первая находка своего вида старше следующих,
 * сбой файла правил — отказ строки его текстом.
 */

import { assertEquals } from "@std/assert";
import type { RefusalData } from "../frames/mod.ts";
import {
  ALLOW,
  ASK,
  DENY,
  PolicyError,
  Rule,
  RulePath,
  Rules,
  type Ruling,
} from "../policy/mod.ts";
import { Ahead, entryOf } from "./ahead.ts";

const RULES = new Rules([
  new Rule(RulePath.parse("*"), ALLOW),
  new Rule(RulePath.parse("kiten comment"), ASK),
  new Rule(RulePath.parse("kiten card"), ASK),
  new Rule(RulePath.parse("sql"), DENY),
]);

/** Итог обхода команд `paths` строки `words`: код и stderr. */
async function verdict(
  words: readonly string[],
  paths: readonly string[],
  decide: (links: readonly string[]) => Ruling = (links) => RULES.decide(links),
) {
  const ahead = new Ahead(words);
  for (const path of paths) {
    const parts = path.split(" ");
    ahead.command(parts, parts);
  }
  let stderr = "";
  const finding = await ahead.verdict(decide, entryOf(words).ahead);
  const code = await finding.settle({
    stdout: () => {},
    stderr: (text) => void (stderr += text),
    refusal: (_data: RefusalData) => {},
  }, () => Promise.resolve(0));
  return { code, stderr };
}

Deno.test("итог обхода: кто старше", async (t) => {
  const line = ["x"];
  const cases: readonly [string, readonly string[], number, string][] = [
    ["только чтение", ["kiten ls"], 0, ""],
    [
      "первая запись без двери называет отказ",
      ["kiten comment", "kiten card"],
      2,
      "mpu x: строка может записать (kiten comment) — начни с ask: mpu ask x\n",
    ],
    [
      "запрет после записи",
      ["kiten comment", "sql"],
      1,
      "mpu sql: запрещено правилом «sql»\n",
    ],
    [
      "запрет до записи",
      ["sql", "kiten comment"],
      1,
      "mpu sql: запрещено правилом «sql»\n",
    ],
  ];
  for (const [name, paths, code, stderr] of cases) {
    await t.step(name, async () => {
      assertEquals(await verdict(line, paths), { code, stderr });
    });
  }
});

Deno.test("итог обхода: в двери запись проходит, запрет — нет", async () => {
  assertEquals(await verdict(["ask", "x"], ["kiten comment"]), {
    code: 0,
    stderr: "",
  });
  assertEquals(await verdict(["ask", "x"], ["kiten comment", "sql"]), {
    code: 1,
    stderr: "mpu sql: запрещено правилом «sql»\n",
  });
});

Deno.test("файл правил не читается — отказ строки его текстом", async () => {
  const broken = () => {
    throw new PolicyError("файл правил испорчен");
  };
  assertEquals(await verdict(["x"], ["kiten ls"], broken), {
    code: 1,
    stderr: "файл правил испорчен\n",
  });
});
