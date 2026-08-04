/**
 * Видимость команд обоих маршрутов: справочные поверхности перечисляют
 * их одинаково (`platform/registry.md`), а состав тулов задаётся
 * закрытым списком публикации, а не маршрутом.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { commands, findLegacy, legacyCommands } from "./mod.ts";
import { type Profile, profileTools } from "../mcp/mod.ts";

const PROFILES: readonly Profile[] = ["ro", "rw"];

async function help(...argv: string[]): Promise<string> {
  const out: string[] = [];
  await runCli(argv, makeFakeIo(), {
    stdout: (text) => void out.push(text),
    stderr: () => {},
  });
  return out.join("");
}

Deno.test("пилотная команда маршрута legacy есть в реестре", () => {
  const entry = findLegacy(["sql-ro"]);
  assertEquals(entry?.path, ["sql-ro"]);
  // Однострока обязательна: из неё собирается индекс родителя.
  assertEquals((entry?.summary ?? "").length > 0, true);
  // Командой контракта она не является — схем и рендера у неё нет.
  assertEquals(commands.some((c) => c.path.join(" ") === "sql-ro"), false);
});

Deno.test("одно имя — один маршрут", () => {
  // Маршрутизация детерминирована (`platform/registry.md`): имя не
  // может лежать в обоих списках, иначе исход зависел бы от порядка
  // проверок в точке входа.
  const native = new Set(commands.map((command) => command.path.join(" ")));
  assertEquals(
    legacyCommands
      .map((command) => command.path.join(" "))
      .filter((name) => native.has(name)),
    [],
  );
});

Deno.test("инварианты записей реестра", async (t) => {
  const entries = [
    ...commands.map((command) => ({
      name: command.path.join(" "),
      summary: command.summary,
      route: "native" as const,
    })),
    ...legacyCommands.map((command) => ({
      name: command.path.join(" "),
      summary: command.summary,
      route: "legacy" as const,
    })),
  ];

  await t.step("у каждой записи непустая однострока", () => {
    assertEquals(
      entries.filter((entry) => entry.summary.trim() === "").map((e) => e.name),
      [],
    );
  });

  await t.step("маршрут объявлен и ровно один", () => {
    // Маршрут выражен списком, в котором лежит запись: пересечение
    // списков означало бы имя с двумя маршрутами сразу.
    for (const entry of entries) {
      assertEquals(
        entry.route === "native" || entry.route === "legacy",
        true,
        `${entry.name}: маршрут не объявлен`,
      );
    }
  });

  await t.step("имена уникальны", () => {
    const names = entries.map((entry) => entry.name);
    assertEquals(new Set(names).size, names.length, "в реестре есть дубли");
  });

  await t.step("порядок стабилен между обращениями", () => {
    const once = legacyCommands.map((command) => command.path.join(" "));
    const twice = legacyCommands.map((command) => command.path.join(" "));
    assertEquals(once, twice);
    // Порядок — порядок слепка, не алфавит: первым идёт `search`.
    assertEquals(once[0], "search");
  });
});

Deno.test("справка перечисляет команды обоих маршрутов", async () => {
  const index = await help("--help");
  assertStringIncludes(index, "sql-ro");
  assertStringIncludes(index, "xlsx");
  // Порядок — порядок реестра: native впереди, legacy следом.
  assertEquals(index.indexOf("xlsx") < index.indexOf("sql-ro"), true);
});

Deno.test("запись в реестре сама по себе состав тулов не меняет", async (t) => {
  // Публикацией legacy-тулов занимается отдельная задача; здесь важно
  // лишь то, что появление записи ничего не опубликовало само.
  for (const profile of PROFILES) {
    await t.step(profile, async () => {
      const published = profileTools(commands, profile).map((e) => e.tool);
      const snapshot = JSON.parse(
        await Deno.readTextFile(
          new URL(`../mcp/testdata/tools-${profile}.json`, import.meta.url),
        ),
      );
      assertEquals(
        published.map((tool) => tool.name),
        snapshot.map((tool: { name: string }) => tool.name),
      );
      // И ни один тул не соответствует команде маршрута legacy.
      const legacyNames = legacyCommands.map((c) => c.path.join("_"));
      assertEquals(
        published.filter((tool) => legacyNames.includes(tool.name)),
        [],
      );
    });
  }
});
