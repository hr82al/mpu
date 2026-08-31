/**
 * Список выброшенных имён сверяется со слепком и с реестром: он обязан
 * называть то, что в прежней реализации действительно было, и то, чего
 * в нашей действительно нет.
 */

import { assertEquals } from "@std/assert";
import { DROPPED } from "./dropped.ts";
import { readManifest } from "./manifest.ts";
import { commands, findGroup } from "./mod.ts";
import treeManifest from "../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};
import toolPolicies from "../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
  type: "json",
};

Deno.test("выброшенные имена: были в слепке, нет в реестре", async (t) => {
  const manifest = readManifest(treeManifest);
  // Пустой список сделал бы цикл ниже утверждением ни о чём.
  assertEquals(DROPPED.length > 0, true);

  for (const entry of DROPPED) {
    const name = entry.path.join(" ");
    await t.step(name, () => {
      // Имя настоящее: опечатка в списке иначе выглядела бы как
      // осознанный отказ от несуществующей команды.
      assertEquals(
        manifest.commands.some((node) => node.path.join(" ") === name),
        true,
        `${name}: такого имени нет в слепке`,
      );
      // И реализации у него нет — ни командой, ни промежуточным
      // уровнем: иначе список врал бы о выброшенном.
      assertEquals(
        commands.some((command) =>
          command.path.slice(0, entry.path.length).join(" ") === name
        ),
        false,
        `${name}: имя есть в реестре`,
      );
      assertEquals(findGroup(entry.path), undefined, `${name}: это группа`);
      // И тула у него не публикуется: закрытый список тоже не должен
      // помнить выброшенное имя.
      assertEquals(
        [...toolPolicies.ro, ...toolPolicies.rw, ...toolPolicies.destructive]
          .some((published) =>
            published === name ||
            published.startsWith(`${name} `)
          ),
        false,
        `${name}: имя осталось в закрытом списке публикации`,
      );
      assertEquals(entry.reason.length > 0, true, `${name}: причина пуста`);
    });
  }
});
