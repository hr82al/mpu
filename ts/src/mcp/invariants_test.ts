/**
 * Инварианты MCP-сервера (`platform/mcp-server.md`) — обходом реестра и
 * закрытого списка публикации, без транспорта.
 */

import { assertEquals, assertLess, assertThrows } from "@std/assert";
import type { Command } from "../command/mod.ts";
import { commands } from "../registry/mod.ts";
import {
  type Profile,
  PROFILE_INSTRUCTIONS,
  profileTools,
  toolName,
  ToolPolicyError,
  toolsSnapshot,
} from "./mod.ts";
import toolPolicies from "../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
  type: "json",
};
import type { LegacyLeaf } from "./legacy_tools.ts";
import { readManifest } from "./legacy_tools.ts";
import { assertDestructivePublished, publishableLegacy } from "./tools.ts";
import treeManifest from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

const PROFILES: readonly Profile[] = ["ro", "rw"];

/** Предел клиента: описание и инструкции обрезаются ровно на нём. */
const DESCRIPTION_LIMIT = 2048;

const utf8 = new TextEncoder();

Deno.test("профили не пересекаются и на /ro нет политики rw", () => {
  const ro = profileTools(commands, "ro");
  const rw = profileTools(commands, "rw");
  const rwNames = new Set(rw.map((entry) => entry.tool.name));
  assertEquals(
    ro.filter((entry) => rwNames.has(entry.tool.name)).map((e) => e.tool.name),
    [],
  );
  assertEquals(
    ro.filter((entry) => entry.policy === "rw").map((e) => e.tool.name),
    [],
  );
  assertEquals(
    rw.filter((entry) => entry.policy === "ro").map((e) => e.tool.name),
    [],
  );
  // Профили в сумме дают ровно закрытый список — ни больше, ни меньше.
  assertEquals(ro.length, toolPolicies.ro.length);
  assertEquals(rw.length, toolPolicies.rw.length);
});

Deno.test("имя тула уникально в профиле и восстанавливает путь", () => {
  for (const profile of PROFILES) {
    const entries = profileTools(commands, profile);
    const names = entries.map((entry) => entry.tool.name);
    assertEquals(new Set(names).size, names.length, `дубли имён в ${profile}`);
    for (const entry of entries) {
      assertEquals(entry.tool.name, toolName(entry.path));
      assertEquals(entry.tool.title, `mpu ${entry.path.join(" ")}`);
    }
  }
});

Deno.test("схема аргументов не ветвится на верхнем уровне", () => {
  for (const profile of PROFILES) {
    for (const { tool } of profileTools(commands, profile)) {
      const keys = Object.keys(tool.inputSchema);
      for (const branch of ["anyOf", "oneOf", "allOf"]) {
        assertEquals(
          keys.includes(branch),
          false,
          `${tool.name}: схема аргументов содержит ${branch}`,
        );
      }
      assertEquals(tool.inputSchema["type"], "object");
    }
  }
});

Deno.test("описание тула и инструкции профиля укладываются в предел", () => {
  for (const profile of PROFILES) {
    assertLess(
      utf8.encode(PROFILE_INSTRUCTIONS[profile]).length,
      DESCRIPTION_LIMIT,
      `инструкции профиля ${profile} длиннее предела`,
    );
    for (const { tool } of profileTools(commands, profile)) {
      assertLess(
        utf8.encode(tool.description).length,
        DESCRIPTION_LIMIT,
        `${tool.name}: описание длиннее предела`,
      );
    }
  }
});

Deno.test("список тулов профиля побитово одинаков между вызовами", () => {
  for (const profile of PROFILES) {
    const first = JSON.stringify(
      profileTools(commands, profile).map((entry) => entry.tool),
    );
    const second = JSON.stringify(
      profileTools(commands, profile).map((entry) => entry.tool),
    );
    assertEquals(first, second);
  }
});

Deno.test("маршрут листа виден по форме опубликованного тула", () => {
  // Смена маршрута меняет форму ответа тула: у `legacy` это текст
  // подпроцесса и схемы результата нет вовсе, у `native` — структурный
  // результат по объявлению команды (`platform/mcp-server.md`). Состав
  // тулов при этом тот же: имена лежат в закрытом списке публикации.
  // Пара взята из разных профилей, и это вынужденно: в профиле `ro`
  // подпроцессных тулов не осталось вовсе — `sheet batch-get` был
  // последним и переехал вместе с `batch-update`. Образец маршрута
  // `legacy` поэтому берётся из `rw`: группа `api` останется там до
  // переезда своей пишущей половины.
  const tools = profileTools(commands, "ro");
  const native = tools.find((entry) => entry.tool.name === "kiten_card");
  const legacy = profileTools(commands, "rw").find(
    (entry) => entry.tool.name === "api_wb_loader_status",
  );

  assertEquals(native?.path, ["kiten", "card"]);
  assertEquals(
    native?.tool.outputSchema?.["type"],
    "object",
    "у native-тула объявлена схема результата",
  );
  assertEquals(legacy?.path, ["api", "wb-loader-status"]);
  // У подпроцессного тула схемы результата нет и быть не может: он
  // отдаёт текст.
  assertEquals(legacy?.tool.outputSchema, undefined);
  // Тул не задвоился: имя, опубликованное нативно, из слепка не берётся.
  assertEquals(
    tools.filter((entry) => entry.tool.name === "kiten_card").length,
    1,
  );
});

Deno.test("snapshot списка тулов по каждому профилю", async (t) => {
  for (const profile of PROFILES) {
    await t.step(profile, async () => {
      const url = new URL(`testdata/tools-${profile}.json`, import.meta.url);
      assertEquals(
        toolsSnapshot(commands, profile),
        await Deno.readTextFile(url),
      );
    });
  }
});

Deno.test("необратимые тулы требуют подтверждения", async (t) => {
  const destructive = new Set(toolPolicies.destructive);
  const entries = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => ({ profile, entry }))
  );

  await t.step("секция destructive непуста и лежит в rw", () => {
    assertEquals(destructive.size > 0, true);
    assertEquals(
      [...destructive].filter((name) => !toolPolicies.rw.includes(name)),
      [],
      "имя из destructive вне профиля rw",
    );
  });

  await t.step("помеченный тул несёт и аннотацию, и _meta", () => {
    // Аннотация описывает свойство тула для любого клиента; фактическое
    // подтверждение наш клиент включает по `_meta` — поэтому оба.
    for (const { entry } of entries) {
      if (!destructive.has(entry.path.join(" "))) continue;
      assertEquals(
        entry.tool.annotations.destructiveHint,
        true,
        `${entry.tool.name}: нет destructiveHint`,
      );
      assertEquals(
        entry.tool._meta?.["anthropic/requiresUserInteraction"],
        true,
        `${entry.tool.name}: нет требования подтверждения`,
      );
    }
  });

  await t.step("прочие тулы rw не помечены", () => {
    // `mpu sql` роняет данные в клиентской БД, `mpu xlsx alias add`
    // правит локальный алиас — и клиент обязан их различать.
    for (const { profile, entry } of entries) {
      if (profile !== "rw" || destructive.has(entry.path.join(" "))) continue;
      assertEquals(entry.tool.annotations.destructiveHint, undefined);
      assertEquals(entry.tool._meta, undefined);
    }
  });

  await t.step("ни один тул ro не помечен", () => {
    for (const { profile, entry } of entries) {
      if (profile !== "ro") continue;
      assertEquals(entry.tool.annotations.readOnlyHint, true);
      assertEquals(entry.tool.annotations.destructiveHint, undefined);
      assertEquals(entry.tool._meta, undefined);
    }
  });

  await t.step("имя в секции вне публикуемых — отказ сборки", () => {
    // Молчаливый пропуск означал бы, что переименование команды тихо
    // снимает подтверждение с необратимого действия.
    assertThrows(
      () =>
        assertDestructivePublished(
          ["нет-такой-команды"],
          entries.map((item) => item.entry),
          "rw",
        ),
      ToolPolicyError,
      "нет-такой-команды",
    );
  });
});

Deno.test("публикация подчинена закрытому списку", async (t) => {
  const policies = loadPolicies();
  const published = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => ({
      profile,
      name: entry.tool.name,
      command: entry.path.join(" "),
      policy: entry.policy,
    }))
  );

  await t.step("опубликованный набор равен закрытому списку", () => {
    // Полная форма инварианта: ослабление до включения стояло ровно
    // из-за легаси-тулов, а они теперь публикуются.
    assertEquals(
      published.map((item) => item.command).sort(),
      [...policies.ro, ...policies.rw].sort(),
    );
  });

  await t.step("каждое имя списка разрешается в лист слепка", () => {
    const leaves = new Set(
      readManifest(treeManifest).commands.map((leaf) => leaf.path.join(" ")),
    );
    const native = new Set(commands.map((command) => command.path.join(" ")));
    // Команда native живёт в коде, прочие обязаны найтись в слепке —
    // иначе тул некому описать и нечем исполнить.
    assertEquals(
      [...policies.ro, ...policies.rw]
        .filter((name) => !native.has(name) && !leaves.has(name)),
      [],
    );
  });

  await t.step("политика каждого тула совпадает со списком", () => {
    for (const item of published) {
      const inList = policies.ro.includes(item.command) ? "ro" : "rw";
      assertEquals(item.policy, inList, `${item.command}: политика`);
      assertEquals(item.profile, inList, `${item.command}: профиль`);
    }
  });

  await t.step("команда вне списка не публикуется", () => {
    const listed = new Set([...policies.ro, ...policies.rw]);
    const outside = [
      ...commands.map((command) => command.path.join(" ")),
      ...readManifest(treeManifest).commands.map((leaf) => leaf.path.join(" ")),
    ].filter((name) => !listed.has(name));
    // Реестр действительно несёт такие команды: `mpu mcp token` печатает
    // токен доступа, и правило fail-closed — единственное, что держит её
    // вне тулов.
    assertEquals(outside.length > 0, true, "нечего проверять: список полон");
    assertEquals(
      published.filter((item) => outside.includes(item.command)),
      [],
    );
  });

  await t.step("узел дерева тулом не становится", () => {
    const groups = readManifest(treeManifest).commands
      .filter((node) => node.group === true)
      .map((node) => node.path.join(" "));
    assertEquals(groups.length > 0, true, "в слепке нет ни одной группы");
    // Сегодня групп в списке нет — это проверяем...
    assertEquals(
      [...policies.ro, ...policies.rw].filter((name) => groups.includes(name)),
      [],
    );
    assertEquals(
      published.filter((item) => groups.includes(item.command)),
      [],
    );
    // ...но правку списка это не стережёт, поэтому правило проверяется
    // и само по себе: узел с признаком группы не публикуется, даже
    // если его имя в списке есть.
    const asGroup: LegacyLeaf = {
      path: ["xlsx", "ls"],
      params: [],
      summary: "проба",
      help: "проба",
      group: true,
    };
    assertEquals(publishableLegacy([asGroup], "ro"), []);
    const asLeaf: LegacyLeaf = { ...asGroup, group: undefined };
    assertEquals(publishableLegacy([asLeaf], "ro").length, 1);
  });

  await t.step("расхождение политики со списком — отказ собрать тулы", () => {
    const misdeclared: Command = { ...commands[0], policy: "rw" };
    assertEquals(misdeclared.path.join(" "), "xlsx ls");
    assertThrows(
      () => profileTools([misdeclared], "rw"),
      ToolPolicyError,
      "расходится",
    );
  });
});

/** Закрытый список публикации — тот же файл канала, что читает код. */
function loadPolicies(): { ro: readonly string[]; rw: readonly string[] } {
  return { ro: toolPolicies.ro, rw: toolPolicies.rw };
}
