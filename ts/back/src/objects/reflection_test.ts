/**
 * `selectors` и раздел «Сообщения» справки не расходятся ни у одного
 * объекта тестового дерева. Дерево обходится через саму цепочку: из
 * справки берутся селекторы, по каждому — шаг вглубь.
 */

import { assert, assertEquals } from "@std/assert";
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

async function visit(
  root: Call,
  words: readonly string[],
  visited: string[],
): Promise<void> {
  const own = await runChain([...words, "selectors"], root);
  if ("error" in own) {
    assert(
      own.error.endsWith("цепочка окончена, selectors отправить некому"),
      own.error,
    );
    return;
  }
  visited.push(words.join(" "));
  const listed = messages(await textOf(root, [...words, "--help"]));
  assert("value" in own);
  assertEquals(
    own.value,
    listed.filter((s) => !s.startsWith("<")),
    words.join(" "),
  );
  for (const selector of listed) {
    await visit(root, [...words, ...wordsFor(selector)], visited);
  }
}

Deno.test("selectors каждого объекта совпадает с его справкой", async () => {
  const visited: string[] = [];
  await visit(testTree().root, [], visited);
  assertEquals(visited, [
    "",
    "kiten",
    "kiten card",
    "kiten card 123",
    "kiten card 123 comment",
    "kiten card: 123",
    "kiten card: 123 comment",
  ]);
});
