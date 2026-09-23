/**
 * Снимок дерева — вывод протокола отражения (`platform/reflection.md`,
 * «mpu-complete»): у узла `messages`, `keys`, `formats`, `variants` вида узла; ключи
 * команды — из каталога ключей, как у справки.
 */

import { assertEquals } from "@std/assert";
import { commands } from "../registry/mod.ts";
import { addressesOf } from "./keyed.ts";
import { registryNodes, type TreeNode } from "./mod.ts";
import { formatsOf } from "./tree.ts";

function node(path: string): TreeNode {
  const found = registryNodes().find((one) => one.path.join(" ") === path);
  assertEquals(found !== undefined, true, path);
  return found as TreeNode;
}

Deno.test("keys каждой команды — её ключи из каталога", () => {
  const nodes = new Map(
    registryNodes().map((one) => [one.path.join(" "), one]),
  );
  for (const command of commands) {
    const keys = nodes.get(command.path.join(" "))?.keys ?? [];
    const written = keys.map((key) =>
      key.kind === "flag" ? `--${key.name}` : `${key.name}:`
    ).sort();
    const addresses = [
      ...addressesOf(command, Object.keys(formatsOf(command.path))).values(),
    ].filter((address) => !address.includes(" ")).sort();
    assertEquals(written, [...new Set(addresses)], command.path.join(" "));
  }
});

Deno.test("образцы: ключи kiten card, форматы sql-ro, сообщения корня", () => {
  assertEquals(
    node("kiten card").keys.map((key) => [key.name, key.kind, key.required]),
    [["id", "value", true]],
  );
  assertEquals(
    node("kiten card").variants.map((line) => [line.selector, line.input]),
    [["no-comments", "comments"], ["no-images", "images"]],
  );
  assertEquals(node("sql-ro").formats, ["json", "md"]);
  assertEquals(node("kiten").formats, []);
  assertEquals(node("kiten").keys, []);
  const root = node("").messages.map((line) => line.selector);
  for (const selector of ["allow:", "deny:", "forget:", "kiten", "policy"]) {
    assertEquals(root.includes(selector), true, selector);
  }
  assertEquals(
    node("").messages.every((line) => line.purpose !== ""),
    true,
  );
});
