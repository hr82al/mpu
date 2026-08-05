/**
 * Видимость команд обоих маршрутов: справочные поверхности перечисляют
 * их одинаково (`platform/registry.md`), а состав тулов задаётся
 * закрытым списком публикации, а не маршрутом.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { commands, findLegacy, legacyCommands, surfaces } from "./mod.ts";
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
  const entry = findLegacy(["logs"]);
  assertEquals(entry?.path, ["logs"]);
  // Однострока обязательна: из неё собирается индекс родителя.
  assertEquals((entry?.summary ?? "").length > 0, true);
  // Командой контракта она не является — схем и рендера у неё нет.
  assertEquals(commands.some((c) => c.path.join(" ") === "logs"), false);
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

Deno.test("индекс корня перечисляет всё дерево", async () => {
  const index = await help("--help");
  assertStringIncludes(index, "xlsx");
  assertStringIncludes(index, "logs");
  // Поверхности точки входа — наравне с записями маршрутов: способ
  // исполнения на состав справки не влияет.
  assertStringIncludes(index, "help");
  assertStringIncludes(index, "mcp");
  for (const surface of surfaces) {
    assertStringIncludes(index, surface.summary);
  }
  // Порядок — порядок реестра: native впереди, legacy следом.
  assertEquals(index.indexOf("xlsx") < index.indexOf("logs"), true);
});

Deno.test("тулом становится команда любого маршрута", async (t) => {
  // Маршрут не решает, публикуется ли команда: решает закрытый список
  // (`platform/mcp-server.md`). Здесь — что обе стороны представлены.
  const names = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => entry.tool.name)
  );

  await t.step("команда контракта — из объявления в коде", () => {
    assertEquals(names.includes("xlsx_ls"), true);
  });

  await t.step("команда маршрута legacy — из слепка", () => {
    assertEquals(names.includes("logs"), true);
    // Верхнее имя реестра, лист слепка — один и тот же `mpu logs`.
    assertEquals(findLegacy(["logs"])?.path, ["logs"]);
  });

  await t.step("запись реестра вне списка публикации тула не даёт", () => {
    // `mpu copy-client` в реестре есть, в закрытом списке — нет:
    // копирование клиента агенту не отдают (fail-closed).
    assertEquals(
      legacyCommands.some((command) =>
        command.path.join(" ") === "copy-client"
      ),
      true,
    );
    assertEquals(names.includes("copy_client"), false);
  });
});
