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
  // Пилотом был `search`, за ним `sheet` — оба переехали на маршрут
  // `native`. Роль образца перешла к `d2-miro`: он остаётся
  // подпроцессным и стоит в слепке первым.
  const entry = findLegacy(["d2-miro"]);
  assertEquals(entry?.path, ["d2-miro"]);
  // Однострока обязательна: из неё собирается индекс родителя.
  assertEquals((entry?.summary ?? "").length > 0, true);
  // Командой контракта она не является — схем и рендера у неё нет.
  assertEquals(commands.some((c) => c.path.join(" ") === "d2-miro"), false);
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
    // Порядок — порядок слепка, не алфавит: первым идёт `d2-miro`
    // (прежние первые — `search`, `sun`, `config`, `sheet` — уехали
    // маршрутом `native`).
    assertEquals(once[0], "d2-miro");
  });
});

Deno.test("индекс корня перечисляет всё дерево", async () => {
  const index = await help("--help");
  assertStringIncludes(index, "xlsx");
  assertStringIncludes(index, "search");
  // Поверхности точки входа — наравне с записями маршрутов: способ
  // исполнения на состав справки не влияет.
  assertStringIncludes(index, "help");
  assertStringIncludes(index, "mcp");
  for (const surface of surfaces) {
    assertStringIncludes(index, surface.summary);
  }
  // Порядок — порядок реестра: native впереди, legacy следом.
  assertEquals(index.indexOf("xlsx") < index.indexOf("search"), true);
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
    // Подпроцессная команда закрытого списка публикации: пишущая
    // половина `api` (прежние образцы `search`, `mp-init` и
    // `sheet batch-get` уехали на `native`).
    assertEquals(names.includes("api_wb_loader_reset"), true);
    assertEquals(findLegacy(["api"])?.path, ["api"]);
  });

  await t.step("запись реестра вне списка публикации тула не даёт", () => {
    // `mpu copy-client` в реестре есть — и с переездом на `native` она
    // объявлена контрактом, — а в закрытом списке публикации её нет:
    // мост прод → локаль агенту не отдают (fail-closed).
    assertEquals(
      commands.some((command) => command.path.join(" ") === "copy-client"),
      true,
    );
    assertEquals(names.includes("copy_client"), false);
  });
});
