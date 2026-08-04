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
import { commands, legacyCommands, OWN_COMMANDS } from "./mod.ts";
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
    summary: own.get(name) ??
      `${name}: ${(children.get(name) ?? []).join(" | ")}`,
  }));
}

Deno.test("верхний уровень реестра равен верхнему уровню слепка", () => {
  const expected = topLevels().map((entry) => entry.name);
  assertEquals(expected.length, 57, "слепок изменился: имён не 57");

  const registered = [
    ...commands.map((command) => command.path[0]),
    ...legacyCommands.map((command) => command.path[0]),
  ];
  const inherited = registered.filter((name) => !OWN_COMMANDS.includes(name));
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
  const registered = [
    ...commands.map((command) => command.path[0]),
    ...legacyCommands.map((command) => command.path[0]),
  ];
  assertEquals(registered.filter((name) => !known.has(name)), []);
});

Deno.test("однострокѝ записей взяты из слепка", () => {
  const expected = new Map(
    topLevels().map((entry) => [entry.name, entry.summary]),
  );
  for (const command of legacyCommands) {
    assertEquals(
      command.summary,
      expected.get(command.path[0]),
      `${command.path[0]}: однострока разошлась со слепком`,
    );
  }
});
