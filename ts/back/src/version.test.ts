/**
 * Версия сборки: одна и та же величина у бинаря, у реестра и у слепка,
 * из которого реестр порождён. Расхождение с установленной
 * Python-реализацией — то, что обязано быть заметным.
 */

import { expect, it } from "vitest";
import { VERSION } from "./version.ts";
import { runCli } from "./entrypoint/mod.ts";
import { makeFakeIo } from "./testing/mod.ts";
import tree from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

it("версия сборки совпадает с версией слепка", () => {
  // Реестр порождён из слепка: версия бинаря — версия того дерева
  // команд, на которое он рассчитан. Пересъём слепка без пересборки
  // константы роняет этот тест, а не пользователя.
  expect(VERSION).toStrictEqual(tree.mpuVersion);
});

it("mpu version печатает константу сборки одной строкой", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["version"], makeFakeIo(), {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  expect(code).toBe(0);
  // Ни префиксов, ни второй строки (`platform/registry.md`), и вопроса
  // к Python-реализации тоже нет — io её не касается.
  expect(out.join("")).toStrictEqual(`${VERSION}\n`);
  expect(err.join("")).toBe("");
});

it("mpu version --help — своя справка, а не версия", async () => {
  const out: string[] = [];
  const code = await runCli(["version", "--help"], makeFakeIo(), {
    stdout: (text) => void out.push(text),
    stderr: () => {},
  });
  expect(code).toBe(0);
  expect(out.join("")).toContain("Использование: mpu version");
  // Однострока — та же, что в реестре и в списке `mpu help`.
  expect(out.join("")).toContain("Show mpu version.");
  expect(out.join("").includes(`${VERSION}\n`)).toBe(false);
});
