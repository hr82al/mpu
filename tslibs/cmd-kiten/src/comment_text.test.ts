/**
 * Текстовая часть комментария (`docs/specs/kiten-comment.md`): адресаты,
 * `@all`, сборка итогового текста. Сети здесь нет — только таблицы
 * случаев, потому что и в самом коде это чистые преобразования.
 */

import { expect, it } from "vitest";
import {
  commentText,
  expandAllInText,
  mentionsAll,
  recipientsFrom,
  recipientTokens,
} from "./comment_text.ts";

it("токены адресатов: деление по пробелам и ведущий '@'", () => {
  const cases: readonly [readonly string[], string[]][] = [
    [["@ivan"], ["@ivan"]],
    [["ivan"], ["@ivan"]],
    // Значение флага делится по пробелам, повтор флага — продолжение.
    [["@ivan @petr"], ["@ivan", "@petr"]],
    [
      ["@ivan", "@petr"],
      ["@ivan", "@petr"],
    ],
    [["  @ivan   @petr  "], ["@ivan", "@petr"]],
    // Флаг есть, а адресата нет: по этому и отличается «текст не нужен».
    [[""], []],
    [["   "], []],
    [[], []],
  ];
  for (const [values, want] of cases) {
    expect(recipientTokens(values), JSON.stringify(values)).toStrictEqual(want);
  }
});

it("адресаты: раскрытие @all, затем дедуп без учёта регистра", () => {
  const cases: readonly [readonly string[], string | null, string[]][] = [
    // Первое вхождение побеждает — и порядком, и регистром.
    [["@ivan", "@Ivan"], null, ["@ivan"]],
    [["@Teststub", "@teststub"], null, ["@Teststub"]],
    // `@all` разворачивается во владельца и дедупится уже раскрытым.
    [["@all"], "@ivanov", ["@ivanov"]],
    [["@ALL", "@teststub"], "@ivanov", ["@ivanov", "@teststub"]],
    [["@ivanov", "@all"], "@ivanov", ["@ivanov"]],
    // Владельца нет — токен остаётся литеральным.
    [["@all", "@teststub"], null, ["@all", "@teststub"]],
    [[], null, []],
  ];
  for (const [tokens, owner, want] of cases) {
    expect(recipientsFrom(tokens, owner), JSON.stringify(tokens)).toStrictEqual(
      want,
    );
  }
});

it("@all в тексте: самостоятельный токен, не часть слова", () => {
  const cases: readonly [string, boolean][] = [
    ["@all, посмотрите", true],
    ["всем @all", true],
    ["(@all)", true],
    ["@ALL", true],
    ["@allowed нельзя", false],
    ["почта x@all.example", false],
    ["слово all без собаки", false],
    ["", false],
  ];
  for (const [text, want] of cases) {
    expect(mentionsAll(text), text).toStrictEqual(want);
  }
});

it("@all в тексте раскрывается во все вхождения", () => {
  expect(expandAllInText("@all, готово. Ещё раз @All", "@ivanov")).toBe(
    "@ivanov, готово. Ещё раз @ivanov",
  );
  expect(expandAllInText("@allowed и x@all.example", "@ivanov")).toBe(
    "@allowed и x@all.example",
  );
});

it("итоговый текст: адресаты первой строкой, затем пустая", () => {
  expect(commentText(["@a", "@b"], "готово")).toBe("@a @b\n\nготово");
  expect(commentText(["@a"], "")).toBe("@a");
  expect(commentText([], "готово")).toBe("готово");
});
