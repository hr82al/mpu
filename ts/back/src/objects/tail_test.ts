/**
 * Хвост и собственный ответ вида на конец строки
 * (`platform/registry-objects.md`, «Расширение разбора: хвост», «Режим
 * справки»).
 */

import { assertEquals } from "@std/assert";
import {
  DATA,
  type Doc,
  type Ending,
  keyword,
  origin,
  runChain,
  Shape,
  tail,
  unary,
} from "./mod.ts";

const DOC: Doc = { purpose: "проба", help: "Справка: проба." };

/** Состояние строки: сколько раз объект исполнил своё в конце строки. */
class Runs {
  #count = 0;

  run(): number {
    this.#count++;
    return 7;
  }

  count(): number {
    return this.#count;
  }
}

const RUN: Ending<Runs> = {
  finish: (report, self) => Promise.resolve(report.exit(self.run())),
};

const COMMAND: Shape<Runs> = new Shape<Runs>([], {
  fallback: tail("<args>", DOC, () => COMMAND),
  ending: RUN,
});

const GROUP: Shape<Runs> = new Shape<Runs>([
  keyword({ card: "value" }, ["card"], DOC, DATA, () => "card"),
], { fallback: tail("<args>", DOC, () => COMMAND) });

const ROOT = new Shape<Runs>([
  unary("run", DOC, COMMAND, (self) => self),
  unary("grp", DOC, GROUP, (self) => self),
]);

async function chain(words: readonly string[]) {
  const runs = new Runs();
  const outcome = await runChain(words, origin(DOC, ROOT, runs));
  return { outcome, runs: runs.count() };
}

Deno.test("хвост и конец строки", async (t) => {
  const cases: readonly {
    readonly words: readonly string[];
    readonly outcome: unknown;
    readonly runs: number;
  }[] = [
    { words: ["run"], outcome: { path: ["run"], exit: 7 }, runs: 1 },
    {
      words: ["run", "a", "--", "--help"],
      outcome: { path: ["run", "<args>"], exit: 7 },
      runs: 1,
    },
    {
      words: ["run", "a", "--help"],
      outcome: {
        path: ["run", "<args>", "help"],
        value: "Использование: mpu run a <сообщение>\n\nпроба\n\n" +
          "Справка: проба.\n\nСообщения:\n  <args>  проба\n",
      },
      runs: 0,
    },
    {
      // Справка — последним словом: слова за `help` уходят справке.
      words: ["run", "help", "a", "--help"],
      outcome: {
        error: "mpu run help: не понимает a; справка — последним словом: " +
          "mpu run a help",
        code: 2,
      },
      runs: 0,
    },
    {
      words: ["run", "--help"],
      outcome: {
        path: ["run", "help"],
        value: "Использование: mpu run <сообщение>\n\nпроба\n\n" +
          "Справка: проба.\n\nСообщения:\n  <args>  проба\n",
      },
      runs: 0,
    },
    // Ключ, который приёмник знает, — ключевое сообщение и у приёмника с
    // хвостом; незнакомый начинает хвост (`platform/line-grammar.md`).
    {
      words: ["grp", "card:", "1"],
      outcome: { path: ["grp", "card:"], value: "card" },
      runs: 0,
    },
    {
      words: ["grp", "nope:", "1"],
      outcome: { path: ["grp", "<args>"], exit: 7 },
      runs: 1,
    },
    {
      words: ["grp", "messages"],
      outcome: { path: ["grp", "messages"], value: "card:\tпроба\n" },
      runs: 0,
    },
  ];
  for (const c of cases) {
    await t.step(c.words.join(" "), async () => {
      assertEquals(await chain(c.words), {
        outcome: c.outcome,
        runs: c.runs,
      });
    });
  }
});
