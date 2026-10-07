/**
 * Снимок дерева — вывод протокола отражения (`platform/reflection.md`,
 * «mpu-complete»): у узла `messages`, `keys`, `formats`, `variants` вида узла; ключи
 * команды — из каталога ключей, как у справки.
 */

import { expect, it } from "vitest";
import { commands } from "../registry/mod.ts";
import { addressesOf } from "./keyed.ts";
import { registryNodes, type TreeNode } from "./mod.ts";
import { formatsOf } from "./tree.ts";

function node(path: string): TreeNode {
  const found = registryNodes().find((one) => one.path.join(" ") === path);
  expect(found !== undefined, path).toBe(true);
  return found as TreeNode;
}

it("keys каждой команды — её ключи из каталога", () => {
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
    expect(written, command.path.join(" ")).toStrictEqual([
      ...new Set(addresses),
    ]);
  }
});

it("образцы: ключи kiten card, форматы sql-ro, сообщения корня", () => {
  expect(
    node("kiten card").keys.map((key) => [key.name, key.kind, key.required]),
  ).toStrictEqual([["id", "value", true]]);
  expect(node("kiten card").variants.map((line) => [line.selector, line.input]))
    .toStrictEqual([["no-comments", "comments"], ["no-images", "images"]]);
  expect(node("sql-ro").formats).toStrictEqual(["json", "md"]);
  expect(node("kiten").formats).toStrictEqual([]);
  expect(node("kiten").keys).toStrictEqual([]);
  const root = node("").messages.map((line) => line.selector);
  for (const selector of ["allow:", "deny:", "forget:", "kiten", "policy"]) {
    expect(root.includes(selector), selector).toBe(true);
  }
  expect(node("").messages.every((line) => line.purpose !== "")).toBe(true);
});
