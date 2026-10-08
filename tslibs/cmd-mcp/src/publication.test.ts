/**
 * Сборка профиля по закрытому списку публикации (`platform/mcp-server.md`)
 * на синтетических объявлениях: список приносит потребитель, и правила
 * fail-closed, сверки политики и пометки необратимого проверяются здесь
 * без реестра приложения. На настоящем реестре и списке канала те же
 * правила стережёт `ts/back/src/registry/mcp_invariants.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Command, defineCommand, type Policy } from "@mpu/command";
import { thrown } from "@mpu/testing/thrown";
import {
  Publication,
  type PublicationList,
  ToolPolicyError,
} from "./publication.ts";
import { type Profile, REQUIRES_INTERACTION } from "./tool.ts";
import { profileTools } from "./tools.ts";

/** Команда с путём `path` и политикой `policy`; исполнять её не нужно. */
function probe(path: readonly string[], policy: Policy): Command {
  return defineCommand({
    path: [...path],
    summary: "команда для проверки публикации",
    usage: `mpu ${path.join(" ")}`,
    help: "объявление существует только в этом тесте",
    policy,
    argsSchema: z.object({}),
    resultSchema: z.object({}),
    run: () => Promise.resolve({}),
    render: () => "",
  });
}

const READ = probe(["чтение"], "ro");
const WRITE = probe(["запись"], "rw");
const DROP = probe(["удаление"], "rw");
const HIDDEN = probe(["скрытая"], "ro");
const COMMANDS: readonly Command[] = [READ, WRITE, DROP, HIDDEN];

const LIST: PublicationList = {
  ro: ["чтение"],
  rw: ["запись", "удаление"],
  destructive: ["удаление"],
};

/** Имена тулов профиля. */
function names(publication: Publication, profile: Profile) {
  return profileTools(COMMANDS, profile, publication).map(
    (entry) => entry.tool.name,
  );
}

describe("закрытый список публикации", () => {
  it("публикуются только команды списка, каждая в своём профиле", () => {
    const publication = new Publication(LIST);
    expect(names(publication, "ro"), "профиль ro").toStrictEqual(["чтение"]);
    expect(names(publication, "rw"), "профиль rw").toStrictEqual([
      "запись",
      "удаление",
    ]);
  });

  it("политика в коде расходится со списком — отказ собрать профиль", () => {
    const publication = new Publication({ ...LIST, ro: ["чтение", "запись"] });
    thrown(
      () => profileTools(COMMANDS, "ro", publication),
      ToolPolicyError,
      "запись: политика в коде (rw)",
    );
  });

  it("необратимый тул несёт требование подтверждения, прочие — нет", () => {
    const entries = profileTools(COMMANDS, "rw", new Publication(LIST));
    const meta = entries.map((entry) => [
      entry.tool.name,
      entry.tool._meta?.[REQUIRES_INTERACTION] === true,
    ]);
    expect(meta).toStrictEqual([
      ["запись", false],
      ["удаление", true],
    ]);
  });

  it("секция destructive вне публикуемых — отказ собрать rw", () => {
    const publication = new Publication({
      ...LIST,
      destructive: ["удаление", "нет-такой"],
    });
    thrown(
      () => profileTools(COMMANDS, "rw", publication),
      ToolPolicyError,
      "нет-такой",
    );
  });

  it("правка исходного списка не меняет решений объекта", () => {
    const ro = ["чтение"];
    const destructive = ["удаление"];
    const publication = new Publication({ ...LIST, ro, destructive });
    ro.push("скрытая");
    destructive.length = 0;
    expect(publication.policyOf(HIDDEN), "политика").toBeUndefined();
    expect(publication.isDestructive("удаление"), "пометка").toBe(true);
    thrown(
      () => publication.assertDestructivePublished([], "rw"),
      ToolPolicyError,
      "удаление",
    );
  });
});
