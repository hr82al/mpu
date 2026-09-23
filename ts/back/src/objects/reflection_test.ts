/**
 * `messages` и раздел «Сообщения» справки не расходятся ни у одного
 * объекта тестового дерева. Дерево обходится через саму цепочку: из
 * справки берутся селекторы, по каждому — шаг вглубь.
 */

import { assert, assertEquals } from "@std/assert";
import { GRAMMAR } from "../messages/mod.ts";
import { type Call, runChain } from "./mod.ts";
import { testTree } from "./testtree.ts";

/** Пробные слова для строк вида звена и значений ключей. */
const LINK_WORDS: Readonly<Record<string, string>> = {
  "<card>": "123",
  "<text>": "hi",
};
const KEY_VALUE = "123";

function messages(help: string): string[] {
  const [, section = ""] = help.split("Сообщения:\n");
  return section.split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.trim().split(/\s+/)[0]);
}

function wordsFor(selector: string): string[] {
  const sample = LINK_WORDS[selector];
  if (sample !== undefined) return [sample];
  if (!selector.endsWith(":")) return [selector];
  return selector.split(":").filter((key) => key.length > 0)
    .flatMap((key) => [`${key}:`, KEY_VALUE]);
}

async function textOf(root: Call, words: readonly string[]): Promise<string> {
  const outcome = await runChain(words, root);
  assert(
    "value" in outcome,
    `справка ${words.join(" ")}: ${JSON.stringify(outcome)}`,
  );
  return String(outcome.value);
}

/**
 * Слова строки с сообщением `next` объекту, который обозначают `words`:
 * за значением ключа — после закрытия (`platform/line-grammar.md`).
 */
function sending(words: readonly string[], ...next: string[]): string[] {
  const valued = words.at(-2)?.endsWith(":") === true;
  return valued ? [...words, GRAMMAR.close, ...next] : [...words, ...next];
}

async function visit(
  root: Call,
  words: readonly string[],
  visited: string[],
): Promise<void> {
  const own = await runChain(
    sending(words, "messages", GRAMMAR.close, "json"),
    root,
  );
  if ("refused" in own) {
    // Данные сообщений не понимают, а закрытые ответы — только форматы.
    const text = own.refused.text();
    assert(
      text.endsWith("цепочка окончена, messages отправить некому") ||
        text.endsWith("не понимает messages; есть: json"),
      text,
    );
    return;
  }
  visited.push(words.join(" "));
  const listed = messages(await textOf(root, sending(words, "--help")));
  assert("value" in own);
  assertEquals(
    JSON.parse(String(own.value)).map((line: { selector: string }) =>
      line.selector
    ),
    listed.filter((s) => !s.startsWith("<")),
    words.join(" "),
  );
  // Закрытые данные — форматы и отбор: сверены, отбор вглубь не обходится.
  if (listed.includes("json")) return;
  for (const selector of listed) {
    await visit(root, sending(words, ...wordsFor(selector)), visited);
  }
}

Deno.test("messages каждого объекта совпадает с его справкой", async () => {
  const visited: string[] = [];
  await visit(testTree().root, [], visited);
  assertEquals(visited, [
    "",
    "kiten",
    "kiten card",
    "kiten card 123",
    "kiten card 123 comment",
    "kiten card 123 comment: 123",
    "kiten card: 123",
    `kiten card: 123 ${GRAMMAR.close} comment`,
    `kiten card: 123 ${GRAMMAR.close} comment: 123`,
  ]);
});
