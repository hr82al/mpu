/**
 * Команда → строка удалённого шелла (`platform/exec-transport.md`,
 * «Команда → shell-строка»).
 */

import { describe, expect, it } from "vitest";
import { shellCommand } from "./shell.ts";

describe("единственный элемент уходит шеллу как есть", () => {
  const cases: readonly [string, string][] = [
    ["echo hi", "echo hi"],
    // Пайпы, редиректы и присваивания исполняет удалённый шелл — их
    // квотирование сломало бы ровно тот сценарий, ради которого форма
    // единственного элемента и существует.
    ["echo out; echo err 1>&2", "echo out; echo err 1>&2"],
    [
      "VAR=x node cli service:example run",
      "VAR=x node cli service:example run",
    ],
    ["cat a | wc -l", "cat a | wc -l"],
  ];
  for (const [only, expected] of cases) {
    it(only, () => expect(shellCommand([only])).toStrictEqual(expected));
  }
});

describe("несколько элементов: каждый атомарен", () => {
  const cases: readonly [readonly [string, ...string[]], string][] = [
    [["ls", "-la", "/app"], "ls -la /app"],
    [["echo", "a b"], "echo 'a b'"],
    [["echo", "a;b"], "echo 'a;b'"],
    [["echo", "$HOME"], "echo '$HOME'"],
    [["echo", "it's"], `echo 'it'"'"'s'`],
    [["echo", ""], "echo ''"],
    [["node", "--input-type=module", "-"], "node --input-type=module -"],
    // Безопасный набор — ASCII: кириллица квотируется, и это не
    // придирка, а условие атомарности аргумента в чужой локали.
    [["echo", "привет"], "echo 'привет'"],
  ];
  for (const [command, expected] of cases) {
    it(expected, () => expect(shellCommand(command)).toStrictEqual(expected));
  }
});
