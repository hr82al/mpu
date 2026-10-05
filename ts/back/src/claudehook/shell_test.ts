/**
 * Слова Bash-строки (`claude-hook-pre-tool-use.md`, «Разбор Bash-строки»):
 * значения ключей в ответ хука не попадают, поэтому их буквы проверяются
 * здесь, а причины событий — сценариями `cases.json` (`line/hook_test.ts`).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  COMPOUND,
  EXPANSION,
  ShellEvent,
  shellWords,
  SUBSTITUTION,
  UNCLOSED,
} from "./shell.ts";
import { NOT_MPU } from "./reply.ts";

Deno.test("слова: кавычки и экранирование снимаются, как у bash", async (t) => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["mpu a 'b c'", ["mpu", "a", "b c"]],
    ['mpu a "b\\"c"', ["mpu", "a", 'b"c']],
    ['mpu a "b\\c"', ["mpu", "a", "b\\c"]],
    ['mpu a "b\\$c\\\\"', ["mpu", "a", "b$c\\"]],
    ["mpu a 'b\\c $d'", ["mpu", "a", "b\\c $d"]],
    ["mpu a b\\;c", ["mpu", "a", "b;c"]],
    ["mpu a b#c", ["mpu", "a", "b#c"]],
    ["mpu a ''", ["mpu", "a", ""]],
    ["mpu a \\\nb", ["mpu", "a", "b"]],
    ['mpu "a\nb"', ["mpu", "a\nb"]],
    ["mpu a\n\n  ", ["mpu", "a"]],
    ["mpu a!", ["mpu", "a!"]],
  ];
  for (const [command, words] of cases) {
    await t.step(JSON.stringify(command), () => {
      assertEquals(shellWords(command), words);
    });
  }
});

Deno.test("события: первое решает", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["", NOT_MPU],
    ["mpux a", NOT_MPU],
    ["cd x; mpu", NOT_MPU],
    ["mpu a; cd x", COMPOUND],
    ["mpu #a", COMPOUND],
    ["mpu a\nb", COMPOUND],
    ["mpu $(x) ;", SUBSTITUTION],
    ['mpu "a `b`"', SUBSTITUTION],
    ["mpu a*", EXPANSION],
    ["mpu 'a", UNCLOSED],
    ['mpu "a\\"', UNCLOSED],
  ];
  for (const [command, reason] of cases) {
    await t.step(JSON.stringify(command), () => {
      const event = assertThrows(() => shellWords(command), ShellEvent);
      assertEquals(event.reason, reason);
    });
  }
});
