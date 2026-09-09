/**
 * Инварианты MCP-сервера (`platform/mcp-server.md`) — обходом реестра и
 * закрытого списка публикации, без транспорта.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertLessOrEqual,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
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
import { readManifest } from "../registry/manifest.ts";
import { assertDestructivePublished } from "./tools.ts";
// Предел клиента — один на сервер и на его проверку: второе число
// разошлось бы с первым молча.
import { DESCRIPTION_LIMIT } from "./tool.ts";
import treeManifest from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

const PROFILES: readonly Profile[] = ["ro", "rw"];

const utf8 = new TextEncoder();

/** Команды по пути: тул знает путь, а справку и строку использования — реестр. */
function byPath() {
  return new Map(commands.map((command) => [command.path.join(" "), command]));
}

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
  // И самих профилей ровно два: пустой список обошёл бы все проверки
  // ниже, которые ходят по нему циклом, — включая те, что стерегут
  // непустоту наборов внутри профиля.
  assertEquals([...PROFILES], ["ro", "rw"]);
});

Deno.test("имя тула уникально в профиле и восстанавливает путь", () => {
  for (const profile of PROFILES) {
    const entries = profileTools(commands, profile);
    // Пустой профиль не проверил бы ничего: тело цикла не выполнилось
    // бы ни разу, а шаг остался бы зелёным. То же рассуждение у
    // соседних проверок профилей ниже.
    assertEquals(entries.length > 0, true, `профиль ${profile} пуст`);
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
    const entries = profileTools(commands, profile);
    assertEquals(entries.length > 0, true, `профиль ${profile} пуст`);
    for (const { tool } of entries) {
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
    assertLessOrEqual(
      utf8.encode(PROFILE_INSTRUCTIONS[profile]).length,
      DESCRIPTION_LIMIT,
      `инструкции профиля ${profile} длиннее предела`,
    );
    const entries = profileTools(commands, profile);
    assertEquals(entries.length > 0, true, `профиль ${profile} пуст`);
    for (const { tool } of entries) {
      assertLessOrEqual(
        utf8.encode(tool.description).length,
        DESCRIPTION_LIMIT,
        `${tool.name}: описание длиннее предела`,
      );
    }
  }
});

Deno.test("усечение видно, а не молчаливо", () => {
  // Проверка поведенческая: `<=` предела теперь верно по построению —
  // усекает сам сервер. Проверять надо вторую половину требования:
  // уложившееся не тронуто, а усечённое названо усечённым.
  for (const profile of PROFILES) {
    for (const { tool, path } of profileTools(commands, profile)) {
      const command = byPath().get(path.join(" "));
      assertExists(command, `${tool.name}: нет в реестре`);
      const full = `${command.summary}\n\n${command.help}`;
      if (utf8.encode(full).length <= DESCRIPTION_LIMIT) {
        assertEquals(tool.description, full, `${tool.name}: тронуто зря`);
        continue;
      }
      assertEquals(
        tool.description.endsWith("--help`]"),
        true,
        `${tool.name}: обрезано молча:\n${tool.description.slice(-120)}`,
      );
    }
  }
});

Deno.test("усечение оставляет повод звать и контракт аргументов", () => {
  // Что уцелеет, решает порядок изложения справки
  // (`platform/mcp-server.md`, «Объём»): повод звать и контракт
  // аргументов — в начале, примеры и коды выхода жертвуются первыми.
  // Без этой проверки строка спеки держится на внимательности.
  let truncated = 0;
  for (const profile of PROFILES) {
    for (const { tool, path } of profileTools(commands, profile)) {
      const command = byPath().get(path.join(" "));
      assertExists(command, `${tool.name}: нет в реестре`);
      const full = `${command.summary}\n\n${command.help}`;
      // Первый абзац — повод звать; он обязан уцелеть у всех, а не
      // только у усечённых.
      assertEquals(
        tool.description.includes(full.split("\n\n")[1] ?? ""),
        true,
        `${tool.name}: усечение съело повод звать`,
      );
      if (utf8.encode(full).length <= DESCRIPTION_LIMIT) continue;
      truncated++;
      // Имена опций берутся из строки использования — источника, не
      // совпадающего с проверяемым текстом: перевёрстка блока флагов в
      // справке не должна обнулять проверку молча.
      for (const option of command.usage.match(/--[\w-]+/g) ?? []) {
        assertEquals(
          tool.description.includes(option),
          true,
          `${tool.name}: усечение съело контракт аргументов: ${option}`,
        );
      }
    }
  }
  // Пустой набор усечённых сделал бы этот цикл зелёным ни о чём — но
  // требовать здесь его непустоты нельзя: это значило бы требовать,
  // чтобы у кого-то справка была длиннее предела. Само усечение
  // проверено на своих входах (`tool_test.ts`), а здесь — что оно
  // держит порядок на настоящем дереве команд.
  void truncated;
});

/**
 * Перечни, объявившие `total`: рядом с массивом лежит поле общего
 * числа. Обход по всей схеме, включая ветви союзов, — разделы команд
 * `code` объявлены дискриминированным союзом, и перечни живут внутри
 * ветвей.
 */
function countedLists(schema: unknown, at: string): [string, string][] {
  if (Array.isArray(schema)) {
    return schema.flatMap((node, i) => countedLists(node, `${at}[${i}]`));
  }
  if (typeof schema !== "object" || schema === null) return [];
  const node: Record<string, unknown> = { ...schema };
  const props = node["properties"];
  const here: [string, string][] = [];
  if (typeof props === "object" && props !== null && "total" in props) {
    for (const [name, field] of Object.entries(props)) {
      if (typeof field !== "object" || field === null) continue;
      const value: Record<string, unknown> = { ...field };
      if (value["type"] !== "array") continue;
      here.push([`${at}.${name}`, String(value["description"] ?? "")]);
    }
  }
  return [
    ...here,
    ...Object.entries(node).flatMap(([key, value]) =>
      countedLists(value, `${at}.${key}`)
    ),
  ];
}

Deno.test("у перечня, объявившего total, признак усечения назван", () => {
  // Пара «перечень плюс `total`» признаком усечения считается только
  // тогда, когда описание поля прямо об усечении говорит: вывод,
  // который читатель обязан сделать сам, признаком не является
  // (`platform/mcp-server.md`, «Объём»).
  //
  // Проверка именно про пару, а не про всякий режущийся перечень:
  // перечни с ограничителем и без `total` в дереве есть
  // (`telegram ls`, `telegram search`, `health`, `logs`) — у них не то
  // же умолчание, а отсутствие пары целиком, и это вопрос их схем
  // результата, а не описаний полей.
  let found = 0;
  for (const profile of PROFILES) {
    for (const { tool } of profileTools(commands, profile)) {
      for (const [at, said] of countedLists(tool.outputSchema, tool.name)) {
        found++;
        assertStringIncludes(said, "усечён", `${at}: признак не назван`);
      }
    }
  }
  // Пустой обход сделал бы проверку зелёной ни о чём.
  assert(found > 0, "перечней с `total` не нашлось вовсе");
});

Deno.test("список тулов профиля побитово одинаков между вызовами", () => {
  for (const profile of PROFILES) {
    assertEquals(
      profileTools(commands, profile).length > 0,
      true,
      `профиль ${profile} пуст: сравнивать нечего`,
    );
    const first = JSON.stringify(
      profileTools(commands, profile).map((entry) => entry.tool),
    );
    const second = JSON.stringify(
      profileTools(commands, profile).map((entry) => entry.tool),
    );
    assertEquals(first, second);
  }
});

Deno.test("у каждого публикуемого тула есть схема результата", () => {
  // Прежде этот тест сверял две формы ответа: у тула подпроцесса —
  // текст без схемы результата, у тула команды контракта —
  // структурный результат по объявлению. Второй формы больше нет:
  // маршрут `legacy` снят целиком (порция 97). Осталось утверждение о
  // единственной оставшейся: тул публикуется только по объявленной
  // команде, и схема результата у него есть.
  const native = new Set(commands.map((command) => command.path.join(" ")));
  for (const profile of PROFILES) {
    for (const entry of profileTools(commands, profile)) {
      assertEquals(
        native.has(entry.path.join(" ")),
        true,
        `${entry.tool.name}: тул не из объявления команды`,
      );
      assertEquals(
        entry.tool.outputSchema?.["type"],
        "object",
        `${entry.tool.name}: у native-тула объявлена схема результата`,
      );
    }
  }
  // И один поимённо, чтобы проверка не выродилась в обход пустого
  // списка: `kiten card` публикуется читающим профилем.
  const card = profileTools(commands, "ro").find(
    (entry) => entry.tool.name === "kiten_card",
  );
  assertEquals(card?.path, ["kiten", "card"]);
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
    //
    // Тело считается: цикл по пустому набору не выполнился бы ни разу,
    // и шаг остался бы зелёным, ничего не утверждая. Минимум известен —
    // столько имён в секции `destructive`, сколько их опубликовано.
    let checked = 0;
    for (const { entry } of entries) {
      if (!destructive.has(entry.path.join(" "))) continue;
      checked++;
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
    // Сверка с известным минимумом: имён в секции столько же, сколько
    // проверено. Расхождение значит одно из двух — тул потерял
    // пометку либо имя из секции не публикуется вовсе.
    assertEquals(
      checked,
      destructive.size,
      "помеченных проверено не столько, сколько имён в секции",
    );
  });

  await t.step("прочие тулы rw не помечены", () => {
    // `mpu sql` роняет данные в клиентской БД, `mpu xlsx alias add`
    // правит локальный алиас — и клиент обязан их различать.
    let checked = 0;
    for (const { profile, entry } of entries) {
      if (profile !== "rw" || destructive.has(entry.path.join(" "))) continue;
      checked++;
      assertEquals(entry.tool.annotations.destructiveHint, undefined);
      assertEquals(entry.tool._meta, undefined);
    }
    // Пустой профиль `rw` без единого непомеченного тула — не то
    // состояние, о котором шаг молчит: он бы прошёл, не проверив
    // ничего.
    assertEquals(checked > 0, true, "непомеченных тулов rw не нашлось");
  });

  await t.step("ни один тул ro не помечен", () => {
    let checked = 0;
    for (const { profile, entry } of entries) {
      if (profile !== "ro") continue;
      checked++;
      assertEquals(entry.tool.annotations.readOnlyHint, true);
      assertEquals(entry.tool.annotations.destructiveHint, undefined);
      assertEquals(entry.tool._meta, undefined);
    }
    assertEquals(checked > 0, true, "профиль ro оказался пуст");
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

  await t.step("каждое имя списка — команда реестра", () => {
    const native = new Set(commands.map((command) => command.path.join(" ")));
    // Прежде имя могло разрешаться и в лист слепка: подпроцессные
    // команды публиковались тулами. Маршрут снят (порция 97), и
    // источник у тула остался один — объявление команды в коде.
    assertEquals(
      [...policies.ro, ...policies.rw].filter((name) => !native.has(name)),
      [],
    );
  });

  await t.step("политика каждого тула совпадает со списком", () => {
    // Пустой набор прошёл бы цикл молча — того же класса дыра, что и у
    // соседних шагов.
    assertEquals(published.length > 0, true, "опубликованных тулов нет");
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
    // Правило «группа не публикуется» жило в проекции слепка и ушло
    // вместе с маршрутом (порция 97): тул теперь собирается только из
    // команды реестра, а у группы объявления нет вовсе — публиковать
    // нечего по построению. Здесь остаётся наблюдаемая часть: ни одно
    // имя списка не совпадает с промежуточным уровнем дерева.
    const groups = readManifest(treeManifest).commands
      .filter((node) => node.group === true)
      .map((node) => node.path.join(" "));
    assertEquals(groups.length > 0, true, "в слепке нет ни одной группы");
    assertEquals(
      [...policies.ro, ...policies.rw].filter((name) => groups.includes(name)),
      [],
    );
    assertEquals(
      published.filter((item) => groups.includes(item.command)),
      [],
    );
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
