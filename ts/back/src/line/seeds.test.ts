/**
 * Посев правил (`platform/policy.md`, «Посев»): у каждого пути одна
 * посевная строка — второе правило того же пути роняет посев целиком.
 */

import { expect, it } from "vitest";
import { registryMigrations, registrySeeds } from "./seeds.ts";

it("пути посева попарно различны", () => {
  const paths = registrySeeds().map((rule) => rule.entry().path);
  const repeated = paths.filter((path, i) => paths.indexOf(path) !== i);
  expect(repeated).toStrictEqual([]);
});

it("image export — allow вместо посева по признаку rw", () => {
  const image = registrySeeds()
    .map((rule) => rule.entry())
    .filter((entry) => entry.path.startsWith("image"))
    .sort((a, b) => a.path.localeCompare(b.path));
  expect(image).toStrictEqual([
    { path: "image export", verdict: "allow" },
    { path: "image sync", verdict: "ask" },
  ]);
});

it("claude-hook permission-request, stop, elicitation — allow вместо посева по признаку rw", () => {
  const hooks = registrySeeds()
    .map((rule) => rule.entry())
    .filter((entry) => entry.path.startsWith("claude-hook"))
    .sort((a, b) => a.path.localeCompare(b.path));
  expect(hooks).toStrictEqual([
    { path: "claude-hook elicitation", verdict: "allow" },
    { path: "claude-hook notification", verdict: "allow" },
    { path: "claude-hook permission-request", verdict: "allow" },
    { path: "claude-hook pre-tool-use", verdict: "allow" },
    { path: "claude-hook stop", verdict: "allow" },
  ]);
});

it("имена миграций попарно различны", () => {
  const names = registryMigrations().map((one) => one.entry().name);
  const repeated = names.filter((name, i) => names.indexOf(name) !== i);
  expect(repeated).toStrictEqual([]);
});
