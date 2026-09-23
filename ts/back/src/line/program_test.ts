/**
 * Программа через точку входа строки (`platform/evaluator.md`): эталон
 * `testdata/evaluator/cases.json` на подменённом Kaiten, журнал вызовов,
 * правила в момент отправки команды, вид результата команды.
 */

import { assertEquals } from "@std/assert";
import { GRAMMAR } from "../messages/mod.ts";
import { DENY, RuleBook, RulePath } from "../policy/mod.ts";
import golden from "./testdata/evaluator/cases.json" with { type: "json" };
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

Deno.test("эталон вычислителя: строка → stdout, stderr, код", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      for (const one of golden.cases) {
        const ran = await runOnStand(file, words(one.line), stand);
        assertEquals(
          {
            stdout: marked(ran.stdout, stand),
            stderr: marked(ran.stderr, stand),
            exit: ran.exit,
          },
          { stdout: one.stdout, stderr: one.stderr, exit: one.exit },
          one.name,
        );
      }
    })
  ));

Deno.test("журнал: запись программы и своя запись на каждую команду", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        words("x {:=} kiten ls {.} x size {.} kiten ls"),
        stand,
      );
      assertEquals(ran.native, [""]);
      assertEquals(ran.records.map((record) => record.argv.join(" ")), [
        "kiten ls",
        "kiten ls",
      ]);
      assertEquals(
        ran.records.map((record) => record.native),
        [["kiten ls"], ["kiten ls"]],
      );
    })
  ));

Deno.test("вид команды в программе — тот же, что у однокомандной строки", () =>
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
        assertEquals(inside.stdout, alone.stdout, tail.join(" "));
        assertEquals(inside.exit, 0);
      }
    })
  ));

Deno.test("правила решают команду в момент отправки; сделанное не откатывается", () =>
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
      assertEquals(ran.stdout, "2\n");
      assertEquals(ran.exit, 1);
      assertEquals(stand.asked(), 0);
      assertEquals(ran.stderr.includes("запрещено правилом"), true, ran.stderr);
    });
  }));

Deno.test("деление склеенного проверяется до исполнения: команда не исполнена", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(
        file,
        [..."kiten ls eatch:".split(" "), DO, ":c", "c", DONE],
        stand,
      );
      assertEquals(ran.exit, 2);
      assertEquals(stand.asked(), 0);
      assertEquals(ran.records, []);
    })
  ));

Deno.test("справка корня называет слова программы из константы", () =>
  withPolicyFile((file) =>
    withStand(async (stand) => {
      allowEverything(file);
      const ran = await runOnStand(file, ["help"], stand);
      assertEquals(ran.exit, 0);
      const g = GRAMMAR;
      for (
        const shown of [
          `${g.open} ${g.parameter}a ${g.parameter}b … ${g.blockEnd}`,
          `${g.comment} … ${g.close}`,
          `x ${g.assign} <выражение>`,
          `${g.quote}текст из слов${g.quote}`,
          `${g.separator}  разделяет выражения`,
        ]
      ) {
        assertEquals(ran.stdout.includes(shown), true, shown);
      }
    })
  ));
