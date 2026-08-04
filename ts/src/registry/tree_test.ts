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

import { assertEquals } from "@std/assert";
import { commands, legacyCommands, OWN_COMMANDS, surfaces } from "./mod.ts";
import tree from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};

/** Верхнее имя дерева: однострока и подкоманды второго уровня. */
interface TopLevel {
  readonly name: string;
  readonly summary: string;
}

/**
 * Верхний уровень слепка в его порядке. У листа верхнего уровня
 * однострока своя; у составного имени её в слепке нет, и она
 * собирается перечислением подкоманд — данные те же, из слепка.
 */
function topLevels(): readonly TopLevel[] {
  const own = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const leaf of tree.commands) {
    const [name, child] = leaf.path;
    if (child === undefined) own.set(name, leaf.summary);
    else if (!children.get(name)?.includes(child)) {
      children.set(name, [...children.get(name) ?? [], child]);
    }
  }
  const order: string[] = [];
  for (const leaf of tree.commands) {
    if (!order.includes(leaf.path[0])) order.push(leaf.path[0]);
  }
  return order.map((name) => ({
    name,
    summary: own.get(name) ?? composed(name, children.get(name) ?? []),
  }));
}

/**
 * Однострока составного имени: подкоманды, сколько влезает в ширину
 * колонки, и счётчик скрытых. Правило воспроизведено здесь намеренно —
 * тест обязан выводить ожидание сам, а не сверяться с генератором.
 */
function composed(name: string, children: readonly string[]): string {
  const limit = 64;
  const shown: string[] = [];
  let width = 0;
  for (const child of children) {
    if (shown.length > 0 && width + child.length + 3 > limit) break;
    width += child.length + (shown.length > 0 ? 3 : 0);
    shown.push(child);
  }
  const hidden = children.length - shown.length;
  return `${name}: ${shown.join(" | ")}${hidden > 0 ? ` … (+${hidden})` : ""}`;
}

Deno.test("верхний уровень реестра равен верхнему уровню слепка", () => {
  const expected = topLevels().map((entry) => entry.name);
  assertEquals(expected.length, 57, "слепок изменился: имён не 57");

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
  // Команды, которых в Python-версии не было и в слепке быть не может.
  // Список явный: новая команда без правки этой строки уронит тест.
  assertEquals([...OWN_COMMANDS], ["mcp"]);
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
