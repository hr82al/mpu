/**
 * Position инлайн-комментария (`platform/gitlab-api.md`): выбор строки
 * по стороне, диапазоны и form-ключи привязки.
 */

import { describe, expect, it } from "vitest";
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
  diff:
    [
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

describe("сторона решает, какая строка адресуема", () => {
  it("added есть на new-стороне и нет на old", () => {
    expect(findLine(FILE, "new", 7)?.kind).toBe("added");
    // Тот же номер на old-стороне — это удалённая строка, другая.
    expect(findLine(FILE, "old", 7)?.kind).toBe("removed");
  });

  it("context адресуем обеими сторонами", () => {
    expect(findLine(FILE, "new", 8)?.kind).toBe("context");
    expect(findLine(FILE, "old", 8)?.kind).toBe("context");
  });

  it("номера вне диффа не находятся вовсе", () => {
    expect(findLine(FILE, "new", 999)).toStrictEqual(undefined);
    expect(findLine(FILE, "new", 3)).toStrictEqual(undefined);
  });
});

it("комментируемые номера стороны и их диапазоны", () => {
  expect(commentableLines(FILE, "new")).toStrictEqual([4, 5, 6, 7, 8, 9, 10]);
  expect(rangesText(commentableLines(FILE, "new"))).toBe("4-10");
  // Одиночный номер печатается без тире; разрывы разделены запятой.
  expect(rangesText([10, 11, 12, 240])).toBe("10-12, 240");
  expect(rangesText([])).toBe("");
});

describe("form-ключи позиции: номера по типу строки, пути всегда оба", () => {
  it("added — только new_line", () => {
    const form = positionForm(REFS, FILE, findLine(FILE, "new", 7)!);
    expect(form["position[new_line]"]).toBe("7");
    expect(form["position[old_line]"]).toStrictEqual(undefined);
    expect(form["position[position_type]"]).toBe("text");
    expect(form["position[head_sha]"]).toBe("head");
  });

  it("removed — только old_line", () => {
    const form = positionForm(REFS, FILE, findLine(FILE, "old", 7)!);
    expect(form["position[old_line]"]).toBe("7");
    expect(form["position[new_line]"]).toStrictEqual(undefined);
  });

  it("context — обе: без них GitLab не примет привязку", () => {
    const form = positionForm(REFS, FILE, findLine(FILE, "new", 8)!);
    expect(form["position[old_line]"]).toBe("8");
    expect(form["position[new_line]"]).toBe("8");
  });

  it("пути — из файла MR, а не из ввода оператора", () => {
    const renamed = changedFileOf({
      old_path: "src/старый.txt",
      new_path: "src/новый.txt",
      renamed_file: true,
      diff: "@@ -1,1 +1,1 @@\n-раз\n+один\n",
    });
    const form = positionForm(REFS, renamed, findLine(renamed, "new", 1)!);
    // Оператор назовёт одно из двух имён, а привязка требует обоих.
    expect(form["position[old_path]"]).toBe("src/старый.txt");
    expect(form["position[new_path]"]).toBe("src/новый.txt");
  });
});
