/**
 * Версия сборки: одна и та же величина у бинаря, у реестра и у слепка,
 * из которого реестр порождён. Расхождение с установленной
 * Python-реализацией — то, что обязано быть заметным.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { VERSION, versionMismatch } from "./version.ts";
import { runCli } from "./entrypoint/mod.ts";
import { makeFakeIo } from "./testing/mod.ts";
import tree from "../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

Deno.test("версия сборки совпадает с версией слепка", () => {
  // Реестр порождён из слепка: версия бинаря — версия того дерева
  // команд, на которое он рассчитан. Пересъём слепка без пересборки
  // константы роняет этот тест, а не пользователя.
  assertEquals(VERSION, tree.mpuVersion);
});

Deno.test("mpu version печатает константу сборки одной строкой", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["version"], makeFakeIo(), {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
  });
  assertEquals(code, 0);
  // Ни префиксов, ни второй строки (`platform/registry.md`), и вопроса
  // к Python-реализации тоже нет — io её не касается.
  assertEquals(out.join(""), `${VERSION}\n`);
  assertEquals(err.join(""), "");
});

Deno.test("mpu version --help — своя справка, а не версия", async () => {
  const out: string[] = [];
  const code = await runCli(["version", "--help"], makeFakeIo(), {
    stdout: (text) => void out.push(text),
    stderr: () => {},
  });
  assertEquals(code, 0);
  assertStringIncludes(out.join(""), "Использование: mpu version");
  // Однострока — та же, что в реестре и в списке `mpu help`.
  assertStringIncludes(out.join(""), "Show mpu version.");
  assertEquals(out.join("").includes(`${VERSION}\n`), false);
});

Deno.test("расхождение версий распознаётся", async (t) => {
  await t.step("та же версия — молчание", () => {
    assertEquals(versionMismatch(VERSION), undefined);
    assertEquals(versionMismatch(`${VERSION}\n`), undefined);
  });

  await t.step("пустой ответ — молчание", () => {
    // Реализация не сказала версию: гадать не о чем.
    assertEquals(versionMismatch("   "), undefined);
  });

  await t.step("другая версия — названы обе", () => {
    const problem = versionMismatch("0.2.7");
    assertStringIncludes(problem ?? "", "0.2.7");
    assertStringIncludes(problem ?? "", VERSION);
  });
});
