/**
 * Слова Bash-строки (`claude-hook-pre-tool-use.md`, «Разбор Bash-строки»):
 * значения ключей в ответ хука не попадают, поэтому их буквы проверяются
 * здесь, а причины событий — сценариями `cases.json` (`line/hook_test.ts`).
 */

import { describe, expect, it } from "vitest";
import { PRE_TOOL_USE } from "@mpu/language/frames";
import {
  COMPOUND,
  EXPANSION,
  shellCall,
  SUBSTITUTION,
  UNCLOSED,
} from "./shell.ts";
import { type HookReply, NOT_MPU, Undecided } from "./reply.ts";

/** Ответ, которым решающий отвечает на слова: тесту важны сами слова. */
const HEARD: HookReply = new Undecided("слова услышаны");

/** Что разбор строки отдал решающему и что ответил сам. */
async function parsed(command: string) {
  const heard: (readonly string[])[] = [];
  const reply = await shellCall(command).reply((words) => {
    heard.push(words);
    return Promise.resolve(HEARD);
  });
  let stderr = "";
  reply.tell({ stdout: () => {}, stderr: (text) => void (stderr += text) });
  return { heard, stderr };
}

describe("слова: кавычки и экранирование снимаются, как у bash", () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["mpu a 'b c'", ["a", "b c"]],
    ['mpu a "b\\"c"', ["a", 'b"c']],
    ['mpu a "b\\c"', ["a", "b\\c"]],
    ['mpu a "b\\$c\\\\"', ["a", "b$c\\"]],
    ["mpu a 'b\\c $d'", ["a", "b\\c $d"]],
    ["mpu a b\\;c", ["a", "b;c"]],
    ["mpu a b#c", ["a", "b#c"]],
    ["mpu a ''", ["a", ""]],
    ["mpu a \\\nb", ["a", "b"]],
    ['mpu "a\nb"', ["a\nb"]],
    ["mpu a\n\n  ", ["a"]],
    ["mpu a!", ["a!"]],
    ["mpu a\\", ["a\\"]],
    ['mpu "a\\\nb"', ["ab"]],
    ["mpu", []],
  ];
  for (const [command, words] of cases) {
    it(JSON.stringify(command), async () => {
      expect(await parsed(command)).toStrictEqual({
        heard: [words],
        stderr: PRE_TOOL_USE.undecided("слова услышаны"),
      });
    });
  }
});

describe("события: первое решает, ответ — значением", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["", NOT_MPU],
    ["   ", NOT_MPU],
    ["mpux a", NOT_MPU],
    ["cd x; mpu", NOT_MPU],
    ["mpu a; cd x", COMPOUND],
    ["mpu #a", COMPOUND],
    ["mpu a\nb", COMPOUND],
    ["mpu $(x) ;", SUBSTITUTION],
    ['mpu "a `b`"', SUBSTITUTION],
    ["mpu a <x", COMPOUND],
    ["mpu a <(x)", COMPOUND],
    ["mpu a >(x)", COMPOUND],
    ["mpu a)", COMPOUND],
    ["mpu (a)", COMPOUND],
    ["mpu a*", EXPANSION],
    ["mpu a[1]", EXPANSION],
    ["mpu 'a", UNCLOSED],
    ['mpu "a\\"', UNCLOSED],
  ];
  for (const [command, reason] of cases) {
    it(JSON.stringify(command), async () => {
      expect(await parsed(command)).toStrictEqual({
        heard: [],
        stderr: PRE_TOOL_USE.undecided(reason),
      });
    });
  }
});
