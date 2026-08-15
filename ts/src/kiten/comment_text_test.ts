/**
 * Текстовая часть комментария (`docs/specs/kiten-comment.md`): адресаты,
 * `@all`, сборка итогового текста. Сети здесь нет — только таблицы
 * случаев, потому что и в самом коде это чистые преобразования.
 */

import { assertEquals } from "@std/assert";
import {
  commentText,
  expandAllInText,
  mentionsAll,
  recipientsFrom,
  recipientTokens,
} from "./comment_text.ts";

Deno.test("токены адресатов: деление по пробелам и ведущий '@'", () => {
  const cases: readonly [readonly string[], string[]][] = [
    [["@ivan"], ["@ivan"]],
    [["ivan"], ["@ivan"]],
    // Значение флага делится по пробелам, повтор флага — продолжение.
    [["@ivan @petr"], ["@ivan", "@petr"]],
    [["@ivan", "@petr"], ["@ivan", "@petr"]],
    [["  @ivan   @petr  "], ["@ivan", "@petr"]],
    // Флаг есть, а адресата нет: по этому и отличается «текст не нужен».
    [[""], []],
    [["   "], []],
    [[], []],
  ];
  for (const [values, want] of cases) {
    assertEquals(recipientTokens(values), want, JSON.stringify(values));
  }
});

Deno.test("адресаты: раскрытие @all, затем дедуп без учёта регистра", () => {
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
    assertEquals(recipientsFrom(tokens, owner), want, JSON.stringify(tokens));
  }
});

Deno.test("@all в тексте: самостоятельный токен, не часть слова", () => {
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
    assertEquals(mentionsAll(text), want, text);
  }
});

Deno.test("@all в тексте раскрывается во все вхождения", () => {
  assertEquals(
    expandAllInText("@all, готово. Ещё раз @All", "@ivanov"),
    "@ivanov, готово. Ещё раз @ivanov",
  );
  assertEquals(
    expandAllInText("@allowed и x@all.example", "@ivanov"),
    "@allowed и x@all.example",
  );
});

Deno.test("итоговый текст: адресаты первой строкой, затем пустая", () => {
  assertEquals(commentText(["@a", "@b"], "готово"), "@a @b\n\nготово");
  assertEquals(commentText(["@a"], ""), "@a");
  assertEquals(commentText([], "готово"), "готово");
});
