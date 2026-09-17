/**
 * Position инлайн-комментария (`platform/gitlab-api.md`): выбор строки
 * по стороне, диапазоны и form-ключи привязки.
 */

import { assertEquals } from "@std/assert";
import { changedFileOf } from "./model.ts";
import {
  commentableLines,
  findLine,
  positionForm,
  rangesText,
} from "./position.ts";

const REFS = { base_sha: "base", start_sha: "start", head_sha: "head" };

/** Файл с одной удалённой, одной добавленной и контекстом вокруг. */
const FILE = changedFileOf({
  old_path: "src/module.txt",
  new_path: "src/module.txt",
  diff: [
    "@@ -4,7 +4,7 @@",
    " строка 4",
    " строка 5",
    " строка 6",
    "-старая 7",
    "+новая 7",
    " строка 8",
    " строка 9",
    " строка 10",
  ].join("\n") + "\n",
});

Deno.test("сторона решает, какая строка адресуема", async (t) => {
  await t.step("added есть на new-стороне и нет на old", () => {
    assertEquals(findLine(FILE, "new", 7)?.kind, "added");
    // Тот же номер на old-стороне — это удалённая строка, другая.
    assertEquals(findLine(FILE, "old", 7)?.kind, "removed");
  });

  await t.step("context адресуем обеими сторонами", () => {
    assertEquals(findLine(FILE, "new", 8)?.kind, "context");
    assertEquals(findLine(FILE, "old", 8)?.kind, "context");
  });

  await t.step("номера вне диффа не находятся вовсе", () => {
    assertEquals(findLine(FILE, "new", 999), undefined);
    assertEquals(findLine(FILE, "new", 3), undefined);
  });
});

Deno.test("комментируемые номера стороны и их диапазоны", () => {
  assertEquals(commentableLines(FILE, "new"), [4, 5, 6, 7, 8, 9, 10]);
  assertEquals(rangesText(commentableLines(FILE, "new")), "4-10");
  // Одиночный номер печатается без тире; разрывы разделены запятой.
  assertEquals(rangesText([10, 11, 12, 240]), "10-12, 240");
  assertEquals(rangesText([]), "");
});

Deno.test("form-ключи позиции: номера по типу строки, пути всегда оба", async (t) => {
  await t.step("added — только new_line", () => {
    const form = positionForm(REFS, FILE, findLine(FILE, "new", 7)!);
    assertEquals(form["position[new_line]"], "7");
    assertEquals(form["position[old_line]"], undefined);
    assertEquals(form["position[position_type]"], "text");
    assertEquals(form["position[head_sha]"], "head");
  });

  await t.step("removed — только old_line", () => {
    const form = positionForm(REFS, FILE, findLine(FILE, "old", 7)!);
    assertEquals(form["position[old_line]"], "7");
    assertEquals(form["position[new_line]"], undefined);
  });

  await t.step("context — обе: без них GitLab не примет привязку", () => {
    const form = positionForm(REFS, FILE, findLine(FILE, "new", 8)!);
    assertEquals(form["position[old_line]"], "8");
    assertEquals(form["position[new_line]"], "8");
  });

  await t.step("пути — из файла MR, а не из ввода оператора", () => {
    const renamed = changedFileOf({
      old_path: "src/старый.txt",
      new_path: "src/новый.txt",
      renamed_file: true,
      diff: "@@ -1,1 +1,1 @@\n-раз\n+один\n",
    });
    const form = positionForm(REFS, renamed, findLine(renamed, "new", 1)!);
    // Оператор назовёт одно из двух имён, а привязка требует обоих.
    assertEquals(form["position[old_path]"], "src/старый.txt");
    assertEquals(form["position[new_path]"], "src/новый.txt");
  });
});
