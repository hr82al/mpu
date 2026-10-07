/**
 * Список выброшенных имён сверяется со слепком и с реестром: он обязан
 * называть то, что в прежней реализации действительно было, и то, чего
 * в нашей действительно нет.
 */

import { describe, expect, it } from "vitest";
import { DROPPED } from "./dropped.ts";
import { readManifest } from "./manifest.ts";
import { commands, findGroup } from "./mod.ts";
import treeManifest from "../../../docs/specs/fixtures/platform/registry/tree.json" with {
  type: "json",
};
import toolPolicies from "../../../docs/specs/fixtures/mcp-server/tool-policies.json" with {
  type: "json",
};

describe("выброшенные имена: были в слепке, нет в реестре", () => {
  const manifest = readManifest(treeManifest);
  // Пустой список сделал бы цикл ниже утверждением ни о чём.
  expect(DROPPED.length > 0).toBe(true);

  for (const entry of DROPPED) {
    const name = entry.path.join(" ");
    it(name, () => {
      // Имя настоящее: опечатка в списке иначе выглядела бы как
      // осознанный отказ от несуществующей команды.
      expect(
        manifest.commands.some((node) => node.path.join(" ") === name),
        `${name}: такого имени нет в слепке`,
      ).toBe(true);
      // И реализации у него нет — ни командой, ни промежуточным
      // уровнем: иначе список врал бы о выброшенном.
      expect(
        commands.some(
          (command) =>
            command.path.slice(0, entry.path.length).join(" ") === name,
        ),
        `${name}: имя есть в реестре`,
      ).toBe(false);
      expect(findGroup(entry.path), `${name}: это группа`).toStrictEqual(
        undefined,
      );
      // И тула у него не публикуется: закрытый список тоже не должен
      // помнить выброшенное имя.
      expect(
        [
          ...toolPolicies.ro,
          ...toolPolicies.rw,
          ...toolPolicies.destructive,
        ].some(
          (published) => published === name || published.startsWith(`${name} `),
        ),
        `${name}: имя осталось в закрытом списке публикации`,
      ).toBe(false);
      expect(entry.reason.length > 0, `${name}: причина пуста`).toBe(true);
    });
  }
});
