/**
 * Инварианты MCP-сервера (`platform/mcp-server.md`) — обходом реестра и
 * закрытого списка публикации, без транспорта.
 */

import { assertEquals, assertLess } from "@std/assert";
import { commands } from "../registry/mod.ts";
import {
  type Profile,
  PROFILE_INSTRUCTIONS,
  profileTools,
  toolName,
} from "./mod.ts";

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
    ro.filter((entry) => entry.command.policy === "rw").map((e) => e.tool.name),
    [],
  );
  assertEquals(
    rw.filter((entry) => entry.command.policy === "ro").map((e) => e.tool.name),
    [],
  );
  // Профили в сумме дают весь реестр: команда не теряется молча.
  assertEquals(ro.length + rw.length, commands.length);
});

Deno.test("имя тула уникально в профиле и восстанавливает путь", () => {
  for (const profile of PROFILES) {
    const entries = profileTools(commands, profile);
    const names = entries.map((entry) => entry.tool.name);
    assertEquals(new Set(names).size, names.length, `дубли имён в ${profile}`);
    for (const entry of entries) {
      assertEquals(entry.tool.name, toolName(entry.command.path));
      assertEquals(entry.tool.title, `mpu ${entry.command.path.join(" ")}`);
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

Deno.test("snapshot списка тулов по каждому профилю", async (t) => {
  for (const profile of PROFILES) {
    await t.step(profile, async () => {
      const actual = JSON.stringify(
        profileTools(commands, profile).map((entry) => entry.tool),
        null,
        2,
      );
      const url = new URL(`testdata/tools-${profile}.json`, import.meta.url);
      assertEquals(actual, (await Deno.readTextFile(url)).trimEnd());
    });
  }
});

Deno.test("публикация подчинена закрытому списку", async (t) => {
  const policies = await loadPolicies();
  const published = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => ({
      profile,
      name: entry.tool.name,
      command: entry.command.path.join(" "),
      policy: entry.command.policy,
    }))
  );

  await t.step("опубликованное — подмножество списка", () => {
    // Равенства пока нет и быть не может: legacy-тулы публикует
    // отдельная задача, здесь публикуются только команды native.
    const listed = new Set([...policies.ro, ...policies.rw]);
    assertEquals(
      published.filter((item) => !listed.has(item.command)),
      [],
    );
  });

  await t.step("политика в коде совпадает со списком", () => {
    for (const item of published) {
      const inList = policies.ro.includes(item.command) ? "ro" : "rw";
      assertEquals(item.policy, inList, `${item.command}: политика`);
      assertEquals(item.profile, inList, `${item.command}: профиль`);
    }
  });

  await t.step("команда вне списка не публикуется", () => {
    const listed = new Set([...policies.ro, ...policies.rw]);
    const outside = commands
      .map((command) => command.path.join(" "))
      .filter((name) => !listed.has(name));
    assertEquals(
      published.filter((item) => outside.includes(item.command)),
      [],
    );
  });
});

/** Закрытый список публикации из фикстур спеки. */
async function loadPolicies(): Promise<{ ro: string[]; rw: string[] }> {
  const url = new URL("testdata/tool-policies.json", import.meta.url);
  const raw = JSON.parse(await Deno.readTextFile(url));
  return { ro: raw.ro, rw: raw.rw };
}
