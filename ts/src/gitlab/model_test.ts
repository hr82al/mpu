/**
 * Формы ответов GitLab (`platform/gitlab-api.md`, «Данные ответов»):
 * статус файла, сведение признаков треда и отбор системных нот.
 */

import { assertEquals } from "@std/assert";
import {
  changedFileOf,
  diffRefsOf,
  discussionsOf,
  fileStatus,
  mergeRequestOf,
  type RawObject,
} from "./model.ts";

const note = (overrides: RawObject = {}): RawObject => ({
  id: 1,
  body: "тело",
  author: { name: "Имя", username: "user" },
  created_at: "2026-08-27T17:00:10.721Z",
  updated_at: "2026-08-27T17:00:10.721Z",
  system: false,
  resolvable: true,
  resolved: false,
  type: "DiffNote",
  ...overrides,
});

Deno.test("статус файла — в порядке проверки спеки", () => {
  // Переименованный новый файл — A: порядок проверки, а не набор
  // флагов, решает, какую букву увидит оператор.
  assertEquals(fileStatus({ new_file: true, renamed_file: true }), "A");
  assertEquals(fileStatus({ deleted_file: true, renamed_file: true }), "D");
  assertEquals(fileStatus({ renamed_file: true }), "R");
  assertEquals(fileStatus({}), "M");
});

Deno.test("файл MR: счётчики считаются из его же diff", () => {
  const file = changedFileOf({
    old_path: "a.ts",
    new_path: "b.ts",
    renamed_file: true,
    diff: "@@ -1,1 +1,2 @@\n-раз\n+один\n+два\n",
  });
  assertEquals([file.status, file.additions, file.deletions], ["R", 2, 1]);
  // Binary-файл приходит с пустым diff — это ноль, а не отказ.
  assertEquals(changedFileOf({ diff: "" }).additions, 0);
});

Deno.test("diff_refs: только полный набор трёх SHA", () => {
  const full = { base_sha: "a", start_sha: "b", head_sha: "c" };
  assertEquals(diffRefsOf({ diff_refs: full }), full);
  // Половина набора означала бы инлайн без якоря — такого не бывает.
  assertEquals(
    diffRefsOf({ diff_refs: { base_sha: "a", head_sha: "c" } }),
    null,
  );
  assertEquals(diffRefsOf({}), null);
});

Deno.test("шапка MR: project из адресации, пустые SHA — null", () => {
  const mr = mergeRequestOf({
    iid: 456,
    title: "заголовок",
    state: "opened",
    author: { name: "Имя Фамилия", username: "user" },
    squash_commit_sha: "",
    project_id: 1001,
  }, "group/repo");
  assertEquals(mr.project, "group/repo");
  assertEquals(mr.author_username, "user");
  // Пустая строка от API равнозначна отсутствию: в JSON уходит null.
  assertEquals(mr.squash_commit_sha, null);
  assertEquals(mr.description, "");
});

Deno.test("треды: системные ноты не достигают потребителя", async (t) => {
  const raw: readonly RawObject[] = [
    {
      id: "aaaa1111",
      notes: [
        note({ system: true, body: "изменил заголовок" }),
        note({ id: 2 }),
      ],
    },
    { id: "bbbb2222", notes: [note({ system: true })] },
  ];
  const discussions = discussionsOf(raw);

  await t.step("системная нота отброшена, обычная осталась", () => {
    assertEquals(discussions.length, 1);
    assertEquals(discussions[0].notes.map((n) => n.id), [2]);
  });

  await t.step("тред из одних системных нот выпадает целиком", () => {
    assertEquals(discussions.map((d) => d.id), ["aaaa1111"]);
  });
});

Deno.test("треды: resolvable/resolved и позиция первой ноты с ней", async (t) => {
  await t.step("general-тред: оба признака ложны, позиции нет", () => {
    const [general] = discussionsOf([
      { id: "cccc", notes: [note({ resolvable: false, type: null })] },
    ]);
    assertEquals([general.resolvable, general.resolved], [false, false]);
    // Единственный признак, отличающий общий тред от инлайнового.
    assertEquals(general.position, null);
  });

  await t.step("resolved только когда все resolvable-ноты закрыты", () => {
    const notes = [note({ resolved: true }), note({ id: 2, resolved: false })];
    assertEquals(discussionsOf([{ id: "dddd", notes }])[0].resolved, false);
    const closed = notes.map((n) => ({ ...n, resolved: true }));
    assertEquals(
      discussionsOf([{ id: "dddd", notes: closed }])[0].resolved,
      true,
    );
  });

  await t.step("позиция треда — первой ноты, у которой она есть", () => {
    const position = {
      old_path: "a.ts",
      new_path: "a.ts",
      old_line: null,
      new_line: 25,
    };
    const [inline] = discussionsOf([
      { id: "eeee", notes: [note({ id: 1 }), note({ id: 2, position })] },
    ]);
    assertEquals(inline.position, position);
  });
});
