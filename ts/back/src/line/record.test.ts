/**
 * Запись результата (`platform/result-record.md`): команда, отдающая одну
 * сущность, — отбор и программа видят то, что печатает `end json`, а не
 * конверт. Строки — на подменённом Kaiten стенда программы.
 */

import { expect, it } from "vitest";
import { GRAMMAR } from "../messages/mod.ts";
import { LastResults } from "./it.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import { runOnStand, unmarked, withStand } from "./testprogram.ts";

const { close: END } = GRAMMAR;

/** Строка с метками — словами строки. */
function words(line: string): string[] {
  return unmarked(line).split(" ");
}

it("kiten card: поля карточки после end", () =>
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
        expect(
          { stdout: ran.stdout, stderr: ran.stderr, exit: ran.exit },
          line,
        ).toStrictEqual({
          stdout,
          stderr: "",
          exit: 0,
        });
      }
    }),
  ));

it("kiten card: у записи нет коллекционных сообщений", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        words("kiten card id: 11 {end} size"),
        stand,
      );
      expect({ stdout: ran.stdout, exit: ran.exit }).toStrictEqual({
        stdout: "",
        exit: 2,
      });
      expect(ran.stderr).toContain("запись не понимает size; ближайшие: ");
    }),
  ));

it("kiten card: вариант после end — прежний отказ, без исполнения", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        words("kiten card id: 11 {end} no-comments"),
        stand,
      );
      expect([ran.exit, ran.native, ran.stderr]).toStrictEqual([
        2,
        [],
        unmarked(
          "mpu kiten card id: 11 {end}: вариант — до ключей: " +
            "mpu kiten card no-comments id: 11\n",
        ),
      ]);
    }),
  ));

it("kiten card: end json — карточка, как без записи", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        ["kiten", "card", "id:", "11", END, "json"],
        stand,
      );
      expect(ran.exit).toBe(0);
      const card = JSON.parse(ran.stdout);
      expect([card.id, card.title, card.comments.length]).toStrictEqual([
        11,
        "один",
        7,
      ]);
    }),
  ));

it("it: поле прошлой карточки, команда не исполняется снова", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const results = new LastResults(() => 0);
      const card = await runOnStand(file, words("kiten card id: 11"), stand, {
        memory: results.of("ppid:1"),
      });
      expect([card.exit, card.native], card.stderr).toStrictEqual([
        0,
        ["kiten card"],
      ]);
      const it = await runOnStand(file, words("it title"), stand, {
        memory: results.of("ppid:1"),
      });
      expect([it.exit, it.stdout, it.native]).toStrictEqual([0, "один\n", []]);
    }),
  ));

it("программа: поле карточки в блоке и в переменной", () =>
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
        expect(
          { stdout: ran.stdout, stderr: ran.stderr, exit: ran.exit },
          line,
        ).toStrictEqual({
          stdout,
          stderr: "",
          exit: 0,
        });
      }
    }),
  ));
