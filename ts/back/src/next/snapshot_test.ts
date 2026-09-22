/**
 * Поля `flags` и `summaries` снимка дерева (`specs/complete.md`,
 * «Снимок»): флаги — из объявления команды, короткая форма — отдельной
 * записью, `--help` не входит; назначения селекторов без своего узла.
 */

import { assertEquals } from "@std/assert";
import { commands } from "../registry/mod.ts";
import { registryNodes, type TreeNode } from "./mod.ts";

function node(path: string): TreeNode {
  const found = registryNodes().find((one) => one.path.join(" ") === path);
  assertEquals(found !== undefined, true, path);
  return found as TreeNode;
}

Deno.test("flags каждой команды — её входы-флаги из объявления", () => {
  const nodes = new Map(
    registryNodes().map((one) => [one.path.join(" "), one]),
  );
  for (const command of commands) {
    const flags = nodes.get(command.path.join(" "))?.flags ?? [];
    const names = new Set(flags.map((flag) => flag.name));
    for (const input of command.inputs) {
      if (input.form.positional !== undefined) continue;
      assertEquals(
        names.has(`--${input.name}`),
        true,
        `${command.path} --${input.name}`,
      );
      if (input.form.short !== undefined) {
        assertEquals(
          names.has(`-${input.form.short}`),
          true,
          `${command.path} -${input.form.short}`,
        );
      }
    }
    assertEquals(names.has("--help"), false, command.path.join(" "));
  }
});

Deno.test("flags: sql-ro с описаниями, короткая форма — своя запись, группы — пусто", () => {
  const sql = node("sql-ro");
  assertEquals(sql.flags.some((flag) => flag.name === "--json"), true);
  assertEquals(
    sql.flags.every((flag) => typeof flag.summary === "string"),
    true,
  );
  const withShort = registryNodes().find((one) =>
    one.flags.some((flag) => /^-[^-]/.test(flag.name))
  );
  assertEquals(withShort !== undefined, true);
  const short = withShort?.flags.find((flag) => /^-[^-]/.test(flag.name));
  const long = withShort?.flags.find((flag) =>
    flag.name.startsWith("--") && flag.summary === short?.summary
  );
  assertEquals(long !== undefined, true);
  assertEquals(node("kiten").flags, []);
  assertEquals(node("ozon-jobs").flags, []);
});

Deno.test("summaries — назначения селекторов без своего узла", () => {
  const root = node("");
  assertEquals(
    Object.keys(root.summaries).sort(),
    ["allow:", "ask:", "deny:", "forget:", "policy"],
  );
  assertEquals(
    Object.values(root.summaries).every((text) => text !== ""),
    true,
  );
  assertEquals(node("kiten").summaries, {});
});
