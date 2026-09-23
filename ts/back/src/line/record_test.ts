/**
 * Запись результата (`platform/result-record.md`): команда, отдающая одну
 * сущность, — отбор и программа видят то, что печатает `end json`, а не
 * конверт. Строки — на подменённом Kaiten стенда программы.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { GRAMMAR } from "../messages/mod.ts";
import { LastResults } from "./it.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import { runOnStand, unmarked, withStand } from "./testprogram.ts";

const { close: END } = GRAMMAR;

/** Строка с метками — словами строки. */
function words(line: string): string[] {
  return unmarked(line).split(" ");
}

Deno.test("kiten card: поля карточки после end", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const cases: readonly [string, string][] = [
        ["kiten card id: 11 {end} title", "один\n"],
        ["kiten card id: 13 {end} state", "done\n"],
        ["kiten card id: 11 {end} comments size", "7\n"],
        ["kiten card id: 12 {end} pick: title", "два\n"],
      ];
      for (const [line, stdout] of cases) {
        const ran = await runOnStand(file, words(line), stand);
        assertEquals(
          { stdout: ran.stdout, stderr: ran.stderr, exit: ran.exit },
          {
            stdout,
            stderr: "",
            exit: 0,
          },
          line,
        );
      }
    })
  ));

Deno.test("kiten card: у записи нет коллекционных сообщений", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        words("kiten card id: 11 {end} size"),
        stand,
      );
      assertEquals({ stdout: ran.stdout, exit: ran.exit }, {
        stdout: "",
        exit: 2,
      });
      assertStringIncludes(ran.stderr, "запись не понимает size; ближайшие: ");
    })
  ));

Deno.test("kiten card: вариант после end — прежний отказ, без исполнения", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        words("kiten card id: 11 {end} no-comments"),
        stand,
      );
      assertEquals([ran.exit, ran.native, ran.stderr], [
        2,
        [],
        unmarked(
          "mpu kiten card id: 11 {end}: вариант — до ключей: " +
            "mpu kiten card no-comments id: 11\n",
        ),
      ]);
    })
  ));

Deno.test("kiten card: end json — карточка, как без записи", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(file, [
        "kiten",
        "card",
        "id:",
        "11",
        END,
        "json",
      ], stand);
      assertEquals(ran.exit, 0);
      const card = JSON.parse(ran.stdout);
      assertEquals([card.id, card.title, card.comments.length], [
        11,
        "один",
        7,
      ]);
    })
  ));

Deno.test("it: поле прошлой карточки, команда не исполняется снова", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const results = new LastResults(() => 0);
      const card = await runOnStand(
        file,
        words("kiten card id: 11"),
        stand,
        [],
        results.of("ppid:1"),
      );
      assertEquals([card.exit, card.native], [0, ["kiten card"]], card.stderr);
      const it = await runOnStand(
        file,
        words("it title"),
        stand,
        [],
        results.of("ppid:1"),
      );
      assertEquals([it.exit, it.stdout, it.native], [0, "один\n", []]);
    })
  ));

Deno.test("программа: поле карточки в блоке и в переменной", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const cases: readonly [string, string][] = [
        [
          "kiten ls first: 2 {end} each: {do} {:}c kiten card id: {@}c id {end} title print {done}",
          "один\nдва\n",
        ],
        ["x {:=} kiten card id: 13 {.} x state", "done\n"],
        ["x {:=} kiten card id: 11 {.} x comments size", "7\n"],
      ];
      for (const [line, stdout] of cases) {
        const ran = await runOnStand(file, words(line), stand);
        assertEquals(
          { stdout: ran.stdout, stderr: ran.stderr, exit: ran.exit },
          {
            stdout,
            stderr: "",
            exit: 0,
          },
          line,
        );
      }
    })
  ));
