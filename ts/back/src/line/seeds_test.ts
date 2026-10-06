/**
 * Посев правил (`platform/policy.md`, «Посев»): у каждого пути одна
 * посевная строка — второе правило того же пути роняет посев целиком.
 */

import { assertEquals } from "@std/assert";
import { registryMigrations, registrySeeds } from "./seeds.ts";

Deno.test("пути посева попарно различны", () => {
  const paths = registrySeeds().map((rule) => rule.entry().path);
  const repeated = paths.filter((path, i) => paths.indexOf(path) !== i);
  assertEquals(repeated, []);
});

Deno.test("image export — allow вместо посева по признаку rw", () => {
  const image = registrySeeds()
    .map((rule) => rule.entry())
    .filter((entry) => entry.path.startsWith("image"))
    .sort((a, b) => a.path.localeCompare(b.path));
  assertEquals(image, [
    { path: "image export", verdict: "allow" },
    { path: "image sync", verdict: "ask" },
  ]);
});

Deno.test("claude-hook permission-request, stop, elicitation — allow вместо посева по признаку rw", () => {
  const hooks = registrySeeds()
    .map((rule) => rule.entry())
    .filter((entry) => entry.path.startsWith("claude-hook"))
    .sort((a, b) => a.path.localeCompare(b.path));
  assertEquals(hooks, [
    { path: "claude-hook elicitation", verdict: "allow" },
    { path: "claude-hook notification", verdict: "allow" },
    { path: "claude-hook permission-request", verdict: "allow" },
    { path: "claude-hook pre-tool-use", verdict: "allow" },
    { path: "claude-hook stop", verdict: "allow" },
  ]);
});

Deno.test("имена миграций попарно различны", () => {
  const names = registryMigrations().map((one) => one.entry().name);
  const repeated = names.filter((name, i) => names.indexOf(name) !== i);
  assertEquals(repeated, []);
});
