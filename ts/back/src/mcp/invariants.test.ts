/**
 * Инварианты MCP-сервера (`platform/mcp-server.md`) — обходом реестра и
 * закрытого списка публикации, без транспорта.
 */

import { readFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
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
import toolPolicies from "../../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
  type: "json",
};
import { readManifest } from "../registry/manifest.ts";
import { assertDestructivePublished } from "./tools.ts";
// Предел клиента — один на сервер и на его проверку: второе число
// разошлось бы с первым молча.
import { DESCRIPTION_LIMIT } from "./tool.ts";
import treeManifest from "../../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

const PROFILES: readonly Profile[] = ["ro", "rw"];

const utf8 = new TextEncoder();

/** Команды по пути: тул знает путь, а справку и строку использования — реестр. */
function byPath() {
  return new Map(commands.map((command) => [command.path.join(" "), command]));
}

it("профили не пересекаются и на /ro нет политики rw", () => {
  const ro = profileTools(commands, "ro");
  const rw = profileTools(commands, "rw");
  const rwNames = new Set(rw.map((entry) => entry.tool.name));
  expect(
    ro.filter((entry) => rwNames.has(entry.tool.name)).map((e) => e.tool.name),
  ).toStrictEqual([]);
  expect(ro.filter((entry) => entry.policy === "rw").map((e) => e.tool.name))
    .toStrictEqual([]);
  expect(rw.filter((entry) => entry.policy === "ro").map((e) => e.tool.name))
    .toStrictEqual([]);
  // Профили в сумме дают ровно закрытый список — ни больше, ни меньше.
  expect(ro.length).toStrictEqual(toolPolicies.ro.length);
  expect(rw.length).toStrictEqual(toolPolicies.rw.length);
  // И самих профилей ровно два: пустой список обошёл бы все проверки
  // ниже, которые ходят по нему циклом, — включая те, что стерегут
  // непустоту наборов внутри профиля.
  expect([...PROFILES]).toStrictEqual(["ro", "rw"]);
});

it("имя тула уникально в профиле и восстанавливает путь", () => {
  for (const profile of PROFILES) {
    const entries = profileTools(commands, profile);
    // Пустой профиль не проверил бы ничего: тело цикла не выполнилось
    // бы ни разу, а шаг остался бы зелёным. То же рассуждение у
    // соседних проверок профилей ниже.
    expect(entries.length > 0, `профиль ${profile} пуст`).toBe(true);
    const names = entries.map((entry) => entry.tool.name);
    expect(new Set(names).size, `дубли имён в ${profile}`).toStrictEqual(
      names.length,
    );
    for (const entry of entries) {
      expect(entry.tool.name).toStrictEqual(toolName(entry.path));
      expect(entry.tool.title).toStrictEqual(`mpu ${entry.path.join(" ")}`);
    }
  }
});

it("схема аргументов не ветвится на верхнем уровне", () => {
  for (const profile of PROFILES) {
    const entries = profileTools(commands, profile);
    expect(entries.length > 0, `профиль ${profile} пуст`).toBe(true);
    for (const { tool } of entries) {
      const keys = Object.keys(tool.inputSchema);
      for (const branch of ["anyOf", "oneOf", "allOf"]) {
        expect(
          keys.includes(branch),
          `${tool.name}: схема аргументов содержит ${branch}`,
        ).toBe(false);
      }
      expect(tool.inputSchema["type"]).toBe("object");
    }
  }
});

it("описание тула и инструкции профиля укладываются в предел", () => {
  for (const profile of PROFILES) {
    expect(
      utf8.encode(PROFILE_INSTRUCTIONS[profile]).length,
      `инструкции профиля ${profile} длиннее предела`,
    ).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    const entries = profileTools(commands, profile);
    expect(entries.length > 0, `профиль ${profile} пуст`).toBe(true);
    for (const { tool } of entries) {
      expect(
        utf8.encode(tool.description).length,
        `${tool.name}: описание длиннее предела`,
      ).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    }
  }
});

it("усечение видно, а не молчаливо", () => {
  // Проверка поведенческая: `<=` предела теперь верно по построению —
  // усекает сам сервер. Проверять надо вторую половину требования:
  // уложившееся не тронуто, а усечённое названо усечённым.
  for (const profile of PROFILES) {
    for (const { tool, path } of profileTools(commands, profile)) {
      const command = byPath().get(path.join(" "));
      assert.exists(command, `${tool.name}: нет в реестре`);
      const full = `${command.summary}\n\n${command.help}`;
      if (utf8.encode(full).length <= DESCRIPTION_LIMIT) {
        expect(tool.description, `${tool.name}: тронуто зря`).toStrictEqual(
          full,
        );
        continue;
      }
      expect(
        tool.description.endsWith("--help`]"),
        `${tool.name}: обрезано молча:\n${tool.description.slice(-120)}`,
      ).toBe(true);
    }
  }
});

it("усечение оставляет повод звать и контракт аргументов", () => {
  // Что уцелеет, решает порядок изложения справки
  // (`platform/mcp-server.md`, «Объём»): повод звать и контракт
  // аргументов — в начале, примеры и коды выхода жертвуются первыми.
  // Без этой проверки строка спеки держится на внимательности.
  let truncated = 0;
  for (const profile of PROFILES) {
    for (const { tool, path } of profileTools(commands, profile)) {
      const command = byPath().get(path.join(" "));
      assert.exists(command, `${tool.name}: нет в реестре`);
      const full = `${command.summary}\n\n${command.help}`;
      // Первый абзац — повод звать; он обязан уцелеть у всех, а не
      // только у усечённых.
      expect(
        tool.description.includes(full.split("\n\n")[1] ?? ""),
        `${tool.name}: усечение съело повод звать`,
      ).toBe(true);
      if (utf8.encode(full).length <= DESCRIPTION_LIMIT) continue;
      truncated++;
      // Имена опций берутся из строки использования — источника, не
      // совпадающего с проверяемым текстом: перевёрстка блока флагов в
      // справке не должна обнулять проверку молча.
      // Ключи (`range:`) — тот же контракт, что опции (`--refresh`).
      const words = command.usage.match(/--[\w-]+|[\w-]+:(?= )/g) ?? [];
      for (const option of words) {
        expect(
          tool.description.includes(option),
          `${tool.name}: усечение съело контракт аргументов: ${option}`,
        ).toBe(true);
      }
    }
  }
  // Пустой набор усечённых сделал бы этот цикл зелёным ни о чём — но
  // требовать здесь его непустоты нельзя: это значило бы требовать,
  // чтобы у кого-то справка была длиннее предела. Само усечение
  // проверено на своих входах (`tool.test.ts`), а здесь — что оно
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

/**
 * Имена входов, которыми тул объявляет ограничитель выдачи. Список
 * закрытый и по делу: имён «на всякий случай» здесь быть не должно —
 * они выглядели бы покрытием, ничего не покрывая. Появится новое —
 * добавить вместе с тулом.
 */
const LIMITERS = ["limit", "tail"];

/** Тулы с ограничителем поимённо: выпадение из обхода — тоже дефект. */
const LIMITED = [
  "code_mentions",
  "code_name",
  "code_refs",
  "code_twins",
  "health",
  "logs",
  "telegram_ls",
  "telegram_search",
];

/** Все описания полей схемы, на любой глубине и во всех ветвях союзов. */
function descriptions(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(descriptions);
  if (typeof schema !== "object" || schema === null) return [];
  const node: Record<string, unknown> = { ...schema };
  const text = node["description"];
  return [
    ...(typeof text === "string" ? [text] : []),
    ...Object.values(node).flatMap(descriptions),
  ];
}

it("у тула с ограничителем признак усечения назван", () => {
  // Ограничитель во входе без признака в результате — это и есть
  // случай, когда клиент не отличит «всё» от «первых N»
  // (`platform/mcp-server.md`, «Объём»). Формы три: пара с полным
  // числом, названное «источник полного числа не сообщает» и признак
  // «есть ещё»; выбор делается по источнику, поэтому проверка требует
  // не формы, а того, что об усечении СКАЗАНО.
  const found: string[] = [];
  for (const profile of PROFILES) {
    for (const { tool } of profileTools(commands, profile)) {
      const inputs = tool.inputSchema["properties"];
      if (typeof inputs !== "object" || inputs === null) continue;
      const limiter = Object.keys(inputs).filter((name) =>
        LIMITERS.includes(name)
      );
      if (limiter.length === 0) continue;
      found.push(tool.name);
      // Слово «усечён» само по себе — не признак: оно должно стоять
      // рядом с тем, чем режут, либо с полем полного числа. Иначе
      // зачлось бы любое мимо-описание с тем же корнем.
      const said = descriptions(tool.outputSchema).filter((text) =>
        text.includes("усеч")
      );
      expect(
        said.some((text) =>
          text.includes("total") || text.includes("more") ||
          limiter.some((name) => text.includes(name))
        ),
        `${tool.name}: ограничитель ${limiter.join(",")} есть, ` +
          `а про усечение результата сказано ${
            said.length === 0 ? "ничего" : `невнятно: ${said.join(" | ")}`
          }`,
      ).toBe(true);
    }
  }
  // Тул, у которого ограничитель переименовали, выпал бы из обхода
  // молча — ровно в тот момент, когда проверка нужнее всего.
  expect([...found].sort()).toStrictEqual(LIMITED);
});

it("у перечня, объявившего total, признак усечения назван", () => {
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
        expect(said, `${at}: признак не назван`).toContain("усечён");
      }
    }
  }
  // Пустой обход сделал бы проверку зелёной ни о чём.
  assert(found > 0, "перечней с `total` не нашлось вовсе");
});

it("список тулов профиля побитово одинаков между вызовами", () => {
  for (const profile of PROFILES) {
    expect(
      profileTools(commands, profile).length > 0,
      `профиль ${profile} пуст: сравнивать нечего`,
    ).toBe(true);
    const first = JSON.stringify(
      profileTools(commands, profile).map((entry) => entry.tool),
    );
    const second = JSON.stringify(
      profileTools(commands, profile).map((entry) => entry.tool),
    );
    expect(first).toStrictEqual(second);
  }
});

it("у каждого публикуемого тула есть схема результата", () => {
  // Прежде этот тест сверял две формы ответа: у тула подпроцесса —
  // текст без схемы результата, у тула команды контракта —
  // структурный результат по объявлению. Второй формы больше нет:
  // маршрут `legacy` снят целиком (порция 97). Осталось утверждение о
  // единственной оставшейся: тул публикуется только по объявленной
  // команде, и схема результата у него есть.
  const native = new Set(commands.map((command) => command.path.join(" ")));
  for (const profile of PROFILES) {
    for (const entry of profileTools(commands, profile)) {
      expect(
        native.has(entry.path.join(" ")),
        `${entry.tool.name}: тул не из объявления команды`,
      ).toBe(true);
      expect(
        entry.tool.outputSchema?.["type"],
        `${entry.tool.name}: у native-тула объявлена схема результата`,
      ).toBe("object");
    }
  }
  // И один поимённо, чтобы проверка не выродилась в обход пустого
  // списка: `kiten card` публикуется читающим профилем.
  const card = profileTools(commands, "ro").find(
    (entry) => entry.tool.name === "kiten_card",
  );
  expect(card?.path).toStrictEqual(["kiten", "card"]);
});

describe("snapshot списка тулов по каждому профилю", () => {
  for (const profile of PROFILES) {
    it(profile, async () => {
      const url = new URL(`testdata/tools-${profile}.json`, import.meta.url);
      expect(toolsSnapshot(commands, profile)).toStrictEqual(
        await readFile(url, "utf8"),
      );
    });
  }
});

describe("необратимые тулы требуют подтверждения", () => {
  const destructive = new Set(toolPolicies.destructive);
  const entries = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => ({ profile, entry }))
  );

  it("секция destructive непуста и лежит в rw", () => {
    expect(destructive.size > 0).toBe(true);
    expect(
      [...destructive].filter((name) => !toolPolicies.rw.includes(name)),
      "имя из destructive вне профиля rw",
    ).toStrictEqual([]);
  });

  it("помеченный тул несёт и аннотацию, и _meta", () => {
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
      expect(
        entry.tool.annotations.destructiveHint,
        `${entry.tool.name}: нет destructiveHint`,
      ).toBe(true);
      expect(
        entry.tool._meta?.["anthropic/requiresUserInteraction"],
        `${entry.tool.name}: нет требования подтверждения`,
      ).toBe(true);
    }
    // Сверка с известным минимумом: имён в секции столько же, сколько
    // проверено. Расхождение значит одно из двух — тул потерял
    // пометку либо имя из секции не публикуется вовсе.
    expect(checked, "помеченных проверено не столько, сколько имён в секции")
      .toStrictEqual(destructive.size);
  });

  it("прочие тулы rw не помечены", () => {
    // `mpu sql` роняет данные в клиентской БД, `mpu xlsx alias add`
    // правит локальный алиас — и клиент обязан их различать.
    let checked = 0;
    for (const { profile, entry } of entries) {
      if (profile !== "rw" || destructive.has(entry.path.join(" "))) continue;
      checked++;
      expect(entry.tool.annotations.destructiveHint).toStrictEqual(undefined);
      expect(entry.tool._meta).toStrictEqual(undefined);
    }
    // Пустой профиль `rw` без единого непомеченного тула — не то
    // состояние, о котором шаг молчит: он бы прошёл, не проверив
    // ничего.
    expect(checked > 0, "непомеченных тулов rw не нашлось").toBe(true);
  });

  it("ни один тул ro не помечен", () => {
    let checked = 0;
    for (const { profile, entry } of entries) {
      if (profile !== "ro") continue;
      checked++;
      expect(entry.tool.annotations.readOnlyHint).toBe(true);
      expect(entry.tool.annotations.destructiveHint).toStrictEqual(undefined);
      expect(entry.tool._meta).toStrictEqual(undefined);
    }
    expect(checked > 0, "профиль ro оказался пуст").toBe(true);
  });

  it("имя в секции вне публикуемых — отказ сборки", () => {
    // Молчаливый пропуск означал бы, что переименование команды тихо
    // снимает подтверждение с необратимого действия.
    thrown(
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

describe("публикация подчинена закрытому списку", () => {
  const policies = loadPolicies();
  const published = PROFILES.flatMap((profile) =>
    profileTools(commands, profile).map((entry) => ({
      profile,
      name: entry.tool.name,
      command: entry.path.join(" "),
      policy: entry.policy,
    }))
  );

  it("опубликованный набор равен закрытому списку", () => {
    // Полная форма инварианта: ослабление до включения стояло ровно
    // из-за легаси-тулов, а они теперь публикуются.
    expect(published.map((item) => item.command).sort()).toStrictEqual(
      [...policies.ro, ...policies.rw].sort(),
    );
  });

  it("каждое имя списка — команда реестра", () => {
    const native = new Set(commands.map((command) => command.path.join(" ")));
    // Прежде имя могло разрешаться и в лист слепка: подпроцессные
    // команды публиковались тулами. Маршрут снят (порция 97), и
    // источник у тула остался один — объявление команды в коде.
    expect([...policies.ro, ...policies.rw].filter((name) => !native.has(name)))
      .toStrictEqual([]);
  });

  it("политика каждого тула совпадает со списком", () => {
    // Пустой набор прошёл бы цикл молча — того же класса дыра, что и у
    // соседних шагов.
    expect(published.length > 0, "опубликованных тулов нет").toBe(true);
    for (const item of published) {
      const inList = policies.ro.includes(item.command) ? "ro" : "rw";
      expect(item.policy, `${item.command}: политика`).toStrictEqual(inList);
      expect(item.profile, `${item.command}: профиль`).toStrictEqual(inList);
    }
  });

  it("команда вне списка не публикуется", () => {
    const listed = new Set([...policies.ro, ...policies.rw]);
    const outside = commands
      .map((command) => command.path.join(" "))
      .filter((name) => !listed.has(name));
    // Реестр действительно несёт такие команды: `mpu mcp token` печатает
    // токен доступа, и правило fail-closed — единственное, что держит её
    // вне тулов.
    expect(outside.length > 0, "нечего проверять: список полон").toBe(true);
    expect(published.filter((item) => outside.includes(item.command)))
      .toStrictEqual([]);
  });

  it("узел дерева тулом не становится", () => {
    // Правило «группа не публикуется» жило в проекции слепка и ушло
    // вместе с маршрутом (порция 97): тул теперь собирается только из
    // команды реестра, а у группы объявления нет вовсе — публиковать
    // нечего по построению. Здесь остаётся наблюдаемая часть: ни одно
    // имя списка не совпадает с промежуточным уровнем дерева.
    const groups = readManifest(treeManifest).commands
      .filter((node) => node.group === true)
      .map((node) => node.path.join(" "));
    expect(groups.length > 0, "в слепке нет ни одной группы").toBe(true);
    expect(
      [...policies.ro, ...policies.rw].filter((name) => groups.includes(name)),
    ).toStrictEqual([]);
    expect(published.filter((item) => groups.includes(item.command)))
      .toStrictEqual([]);
  });

  it("расхождение политики со списком — отказ собрать тулы", () => {
    const misdeclared: Command = { ...commands[0], policy: "rw" };
    expect(misdeclared.path.join(" ")).toBe("xlsx ls");
    thrown(
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
