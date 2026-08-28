/**
 * Состав реестра против машинного слепка дерева
 * (`platform/registry.md`, «Источник записей реестра»). Слепок —
 * единственный источник имён и однострок: golden-файлы справки несут
 * дрейф оригинала и эталонами данных не являются.
 *
 * Правило сборки однострокѝ воспроизводится здесь целиком, а не
 * сверяется с готовым текстом: иначе тест повторял бы за реализацией
 * то, что должен проверять.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { commands, legacyCommands, surfaces } from "./mod.ts";
import tree from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};
import { readManifest } from "../mcp/legacy_tools.ts";
import {
  legacyEntriesFrom,
  NOT_LEGACY,
  TreeSourceError,
} from "./tree_source.ts";

/**
 * Имена верхнего уровня, которых в Python-реализации не было: их нет и
 * не может быть в слепке. Список явный, чтобы новая собственная
 * команда не проскочила мимо проверки состава.
 */
const OWN_COMMANDS: readonly string[] = ["mcp", "jsdate", "claude-hook"];

/** Верхнее имя дерева: имя и его собственная однострока. */
interface TopLevel {
  readonly name: string;
  readonly summary: string;
}

/**
 * Верхний уровень слепка в его порядке. Слепок v2 несёт запись каждого
 * узла — и листа, и группы, — поэтому однострока берётся из записи как
 * есть: собирать её перечислением подкоманд больше не нужно.
 */
function topLevels(): readonly TopLevel[] {
  const tops: TopLevel[] = [];
  for (const node of readManifest(tree).commands) {
    if (node.path.length !== 1) continue;
    tops.push({ name: node.path[0], summary: node.summary });
  }
  return tops;
}

Deno.test("верхний уровень реестра равен верхнему уровню слепка", () => {
  const expected = topLevels().map((entry) => entry.name);
  assertEquals(expected.length, 57, "слепок изменился: имён не 57");
  // Записи узлов пришли со слепком v2: у каждого верхнего имени своя
  // однострока, суррогат из перечисления подкоманд больше не нужен.
  assertEquals(expected.filter((name) => name === "").length, 0);

  const inherited = registeredNames().filter(
    (name) => !OWN_COMMANDS.includes(name),
  );
  assertEquals(
    [...new Set(inherited)].sort(),
    [...expected].sort(),
    "состав реестра разошёлся со слепком",
  );
});

Deno.test("сверх слепка в реестре только собственные поверхности", () => {
  const known = new Set([
    ...topLevels().map((entry) => entry.name),
    ...OWN_COMMANDS,
  ]);
  assertEquals(registeredNames().filter((name) => !known.has(name)), []);
});

/**
 * Имена верхнего уровня всего дерева: команды контракта, записи
 * маршрута `legacy` и поверхности точки входа. Способ исполнения на
 * состав не влияет — иначе поверхность вроде `mpu help` выпала бы из
 * проверки и разошлась со слепком незаметно.
 */
function registeredNames(): readonly string[] {
  return [
    ...commands.map((command) => command.path[0]),
    ...legacyCommands.map((command) => command.path[0]),
    ...surfaces.map((surface) => surface.path[0]),
  ];
}

Deno.test("однострокѝ записей взяты из слепка", () => {
  const expected = new Map(
    topLevels().map((entry) => [entry.name, entry.summary]),
  );
  // Поверхности проверяются наравне с записями маршрута: `mpu help`
  // исполняется своим кодом, но имя и описание у неё унаследованные.
  for (const command of [...legacyCommands, ...surfaces]) {
    assertEquals(
      command.summary,
      expected.get(command.path[0]),
      `${command.path[0]}: однострока разошлась со слепком`,
    );
  }
});

Deno.test("legacy_tree.ts синхронен слепку", async (t) => {
  // Файл порождён скриптом синхронизации; скрипт руками запускают, и в
  // прогон тестов он не попадает — поэтому проверяется его результат и
  // само правило, по которому результат получается.
  const expected = legacyEntriesFrom(readManifest(tree));

  await t.step("состав и однострокѝ совпадают запись в запись", () => {
    assertEquals(
      legacyCommands.map((command) => ({
        path: [...command.path],
        summary: command.summary,
      })),
      expected.map((entry) => ({
        path: [...entry.path],
        summary: entry.summary,
      })),
    );
  });

  await t.step("имена реализованного и поверхностей исключены", () => {
    // `xlsx` — команды контракта, `help` и `version` — поверхности.
    for (const name of NOT_LEGACY) {
      assertEquals(
        legacyCommands.some((command) => command.path[0] === name),
        false,
        `${name} не должен быть записью маршрута legacy`,
      );
      // При этом в слепке они есть — исключение осознанное, а не
      // следствие пропуска в дампе.
      assertEquals(
        readManifest(tree).commands.some((node) => node.path[0] === name),
        true,
      );
    }
  });

  await t.step("пропуск записи в слепке — отказ, а не суррогат", () => {
    const withoutTop = {
      manifestVersion: tree.manifestVersion,
      mpuVersion: tree.mpuVersion,
      // Есть лист второго уровня, а записи его верхнего имени нет.
      // Имя — команды, ещё идущей подпроцессом: у переехавшего
      // целиком (`kiten`, `sheet`) верхнее имя стоит в `NOT_LEGACY` и
      // отфильтровалось бы раньше проверки.
      commands: [
        { path: ["telegram", "ls"], params: [], summary: "s", help: "h" },
      ],
    };
    const err = assertThrows(
      () => legacyEntriesFrom(readManifest(withoutTop)),
      TreeSourceError,
    );
    assertStringIncludes(String(err), "telegram");
  });
});
