/**
 * Программа через точку входа строки (`platform/evaluator.md`): эталон
 * `testdata/evaluator/cases.json` на подменённом Kaiten, журнал вызовов,
 * правила в момент отправки команды, вид результата команды.
 */

import { describe, expect, it } from "vitest";
import { GRAMMAR } from "@mpu/language/messages";
import { DENY, RuleBook, RulePath } from "@mpu/command/policy";
import golden from "./testdata/evaluator/cases.json" with { type: "json" };
import { programPolicy } from "./program.ts";
import { registrySeeds } from "./seeds.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import {
  KAITEN_MARK,
  runOnStand,
  type Stand,
  unmarked,
  withStand,
} from "./testprogram.ts";

const { close: END, open: DO, blockEnd: DONE } = GRAMMAR;

/** Строка с метками — словами строки. */
function words(line: string): string[] {
  return unmarked(line).split(" ");
}

/** Вывод без адреса подменённого Kaiten. */
function marked(text: string, stand: Stand): string {
  return text.replaceAll(stand.baseUrl, KAITEN_MARK);
}

it("эталон вычислителя: строка → stdout, stderr, код", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      for (const one of golden.cases) {
        const ran = await runOnStand(file, words(one.line), stand);
        expect(
          {
            stdout: marked(ran.stdout, stand),
            stderr: marked(ran.stderr, stand),
            exit: ran.exit,
          },
          one.name,
        ).toStrictEqual({
          stdout: one.stdout,
          stderr: one.stderr,
          exit: one.exit,
        });
      }
    }),
  ));

it("журнал: запись программы и своя запись на каждую команду", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        words("x {:=} kiten ls {.} x size {.} kiten ls"),
        stand,
      );
      expect(ran.native).toStrictEqual([""]);
      expect(ran.records.map((record) => record.argv.join(" "))).toStrictEqual([
        "kiten ls",
        "kiten ls",
      ]);
      expect(ran.records.map((record) => record.native)).toStrictEqual([
        ["kiten ls"],
        ["kiten ls"],
      ]);
    }),
  ));

it("вид команды в программе — тот же, что у однокомандной строки", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      for (const tail of [[], [END, "json"]]) {
        const alone = await runOnStand(file, ["kiten", "ls", ...tail], stand);
        const inside = await runOnStand(
          file,
          words(`x {:=} 1 {.} kiten ls ${tail.join(" ")}`.trim()),
          stand,
        );
        expect(inside.stdout, tail.join(" ")).toStrictEqual(alone.stdout);
        expect(inside.exit).toBe(0);
      }
    }),
  ));

it("запрет, найденный обходом, — ничего не исполнено", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    {
      using book = RuleBook.open(file, registrySeeds());
      book.set(RulePath.parse("kiten ls"), DENY);
    }
    await withStand(async (stand) => {
      const ran = await runOnStand(
        file,
        words("2 print {.} kiten ls {.} 3 print"),
        stand,
      );
      expect([ran.stdout, ran.exit, stand.asked()]).toStrictEqual(["", 1, 0]);
      expect(ran.stderr).toBe("mpu kiten ls: запрещено правилом «kiten ls»\n");
    });
  }));

it("деление склеенного проверяется до исполнения: команда не исполнена", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        [..."kiten ls eatch:".split(" "), DO, ":c", "c", DONE],
        stand,
      );
      expect(ran.exit).toBe(2);
      expect(stand.asked()).toBe(0);
      expect(ran.records).toStrictEqual([]);
    }),
  ));

it("справка корня называет слова программы из константы", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(file, ["help"], stand);
      expect(ran.exit).toBe(0);
      const g = GRAMMAR;
      for (const shown of [
        `${g.open} ${g.parameter}a ${g.parameter}b … ${g.blockEnd}`,
        `${g.comment} … ${g.close}`,
        `x ${g.assign} <выражение>`,
        `${g.quote}текст из слов${g.quote}`,
        `${g.separator}  разделяет выражения`,
      ]) {
        expect(ran.stdout.includes(shown), shown).toBe(true);
      }
    }),
  ));

describe("ключ-текст на стенде: текст уходит как есть", () => {
  const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
    [
      ["kiten", "comment", "id:", "11", "text:", "@ivan готово. Проверьте"],
      ["11 @ivan готово. Проверьте"],
    ],
    [
      words("kiten comment id: 11 text: ^ответ: 2^^ готово^"),
      ["11 ответ: 2^ готово"],
    ],
    [
      words(
        "ask kiten ls each: {do} {:}c kiten comment id: {@}c id " +
          "text: {do} {@}c title {end} {done}",
      ),
      ["11 один", "12 два", "13 три"],
    ],
  ];
  for (const [line, posted] of cases) {
    it(line.join(" "), () =>
      withPolicyFile((file) =>
        withStand(async (stand) => {
          allowEverything(file);
          const before = stand.posted().length;
          const ran = await runOnStand(file, line, stand);
          expect(ran.exit, ran.stderr).toBe(0);
          expect(stand.posted().slice(before)).toStrictEqual(posted);
        }),
      ),
    );
  }
});

it("корневое help выражением — справка корня, не запись", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      const ran = await runOnStand(file, words("2 print {.} help"), stand, {
        io: { stdinIsTerminal: () => false, stderrIsTerminal: () => false },
      });
      expect(ran.exit, ran.stderr).toBe(0);
      expect(ran.stdout.startsWith("2\nИспользование: mpu")).toBe(true);
    }),
  ));

it("запись программы: out не пишется, если в ней команда без stdout", () => {
  const call = ["ozon", "call-ro", "target:", "54", "path:", "/v1/seller/info"];
  expect(programPolicy(["1", ".", ...call]).logsStdout).toBe(false);
  expect(programPolicy(["1", ".", "xlsx", "alias", "ls"]).logsStdout).toBe(
    true,
  );
});
