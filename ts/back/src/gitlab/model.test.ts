/**
 * Формы ответов GitLab (`platform/gitlab-api.md`, «Данные ответов»):
 * статус файла, сведение признаков треда и отбор системных нот.
 */

import { describe, expect, it } from "vitest";
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

it("статус файла — в порядке проверки спеки", () => {
  // Переименованный новый файл — A: порядок проверки, а не набор
  // флагов, решает, какую букву увидит оператор.
  expect(fileStatus({ new_file: true, renamed_file: true })).toBe("A");
  expect(fileStatus({ deleted_file: true, renamed_file: true })).toBe("D");
  expect(fileStatus({ renamed_file: true })).toBe("R");
  expect(fileStatus({})).toBe("M");
});

it("файл MR: счётчики считаются из его же diff", () => {
  const file = changedFileOf({
    old_path: "a.ts",
    new_path: "b.ts",
    renamed_file: true,
    diff: "@@ -1,1 +1,2 @@\n-раз\n+один\n+два\n",
  });
  expect([file.status, file.additions, file.deletions]).toStrictEqual([
    "R",
    2,
    1,
  ]);
  // Binary-файл приходит с пустым diff — это ноль, а не отказ.
  expect(changedFileOf({ diff: "" }).additions).toBe(0);
});

it("diff_refs: только полный набор трёх SHA", () => {
  const full = { base_sha: "a", start_sha: "b", head_sha: "c" };
  expect(diffRefsOf({ diff_refs: full })).toStrictEqual(full);
  // Половина набора означала бы инлайн без якоря — такого не бывает.
  expect(diffRefsOf({ diff_refs: { base_sha: "a", head_sha: "c" } }))
    .toStrictEqual(null);
  expect(diffRefsOf({})).toStrictEqual(null);
});

it("шапка MR: project из адресации, пустые SHA — null", () => {
  const mr = mergeRequestOf({
    iid: 456,
    title: "заголовок",
    state: "opened",
    author: { name: "Имя Фамилия", username: "user" },
    squash_commit_sha: "",
    project_id: 1001,
  }, "group/repo");
  expect(mr.project).toBe("group/repo");
  expect(mr.author_username).toBe("user");
  // Пустая строка от API равнозначна отсутствию: в JSON уходит null.
  expect(mr.squash_commit_sha).toStrictEqual(null);
  expect(mr.description).toBe("");
});

describe("треды: системные ноты не достигают потребителя", () => {
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

  it("системная нота отброшена, обычная осталась", () => {
    expect(discussions.length).toBe(1);
    expect(discussions[0].notes.map((n) => n.id)).toStrictEqual([2]);
  });

  it("тред из одних системных нот выпадает целиком", () => {
    expect(discussions.map((d) => d.id)).toStrictEqual(["aaaa1111"]);
  });
});

describe("треды: resolvable/resolved и позиция первой ноты с ней", () => {
  it("general-тред: оба признака ложны, позиции нет", () => {
    const [general] = discussionsOf([
      { id: "cccc", notes: [note({ resolvable: false, type: null })] },
    ]);
    expect([general.resolvable, general.resolved]).toStrictEqual([
      false,
      false,
    ]);
    // Единственный признак, отличающий общий тред от инлайнового.
    expect(general.position).toStrictEqual(null);
  });

  it("resolved только когда все resolvable-ноты закрыты", () => {
    const notes = [note({ resolved: true }), note({ id: 2, resolved: false })];
    expect(discussionsOf([{ id: "dddd", notes }])[0].resolved).toBe(false);
    const closed = notes.map((n) => ({ ...n, resolved: true }));
    expect(discussionsOf([{ id: "dddd", notes: closed }])[0].resolved).toBe(
      true,
    );
  });

  it("позиция треда — первой ноты, у которой она есть", () => {
    const position = {
      old_path: "a.ts",
      new_path: "a.ts",
      old_line: null,
      new_line: 25,
    };
    const [inline] = discussionsOf([
      { id: "eeee", notes: [note({ id: 1 }), note({ id: 2, position })] },
    ]);
    expect(inline.position).toStrictEqual(position);
  });
});
