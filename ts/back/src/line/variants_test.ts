/**
 * Варианты команды (`platform/variants.md`): флаг поведения — унарное
 * сообщение объекту команды до ключей. Пары разбора прежней строки и новой
 * — в `pairs_test.ts`; здесь — отказы, отражение, справка и путь правила.
 * Исполнялась ли команда — по отметке журнала.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { CommandIo } from "../command/mod.ts";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { type Outcome, type Report, runChain } from "../objects/mod.ts";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import type { Line } from "./dispatch.ts";
import { lineEntry } from "./mod.ts";
import type { Order } from "./order.ts";
import { registrySeeds } from "./seeds.ts";
import { allowEverything, consentOf, withPolicyFile } from "./testconsent.ts";
import { registryRoot } from "./tree.ts";

const END = GRAMMAR.close;

/** Строка через `mpu`: код, потоки и команды, дошедшие до исполнения. */
async function run(
  file: string,
  argv: readonly string[],
  answers?: readonly string[],
  io: Partial<CommandIo> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const human = answers === undefined
    ? {}
    : { stdinIsTerminal: () => true, stderrIsTerminal: () => true };
  const code = await lineEntry(consentOf(file, answers))(
    argv,
    makeFakeIo({ ...io, ...human }),
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    journal,
  );
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

/** Строка, которую получила бы прежняя диспетчеризация; исполнения нет. */
class Captured implements Line {
  argv: readonly string[] = [];

  dispatch(report: Report, _view: unknown, order: Order): Promise<Outcome> {
    this.argv = order.argv([]);
    return Promise.resolve(report.exit(0));
  }

  listRules(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }

  change(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }

  streams(): boolean {
    return false;
  }

  terminal(): boolean {
    return false;
  }

  select(report: Report): Promise<Outcome> {
    return Promise.resolve(report.exit(0));
  }
}

Deno.test("вариант не на месте и прежний флаг — отказ с готовой строкой", async (t) => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [
      ["process", "target:", "54", "dry"],
      `mpu process target: 54 ${END}: вариант — до ключей: ` +
      "mpu process dry target: 54",
    ],
    [
      ["process", "verbose", "target:", "54", END, "dry"],
      `mpu process verbose target: 54 ${END}: вариант — до ключей: ` +
      "mpu process verbose dry target: 54",
    ],
    [
      ["process", "target:", "54", "--dry-run"],
      "mpu process: вариант — словом до ключей: mpu process dry target: 54",
    ],
    [
      ["process", "print", "target:", "54", "--dry_run"],
      "mpu process print: вариант — словом до ключей: " +
      "mpu process print dry target: 54",
    ],
    [
      ["logs", "target:", "sl-1", "--via", "portainer"],
      "mpu logs: вариант — словом до ключей: mpu logs portainer target: sl-1",
    ],
    [
      ["logs", "target:", "sl-1", "via:", "nope"],
      "mpu logs: варианта nope нет; есть: loki, portainer",
    ],
    [
      ["kiten", "card", "id:", "1", "--no-comments"],
      "mpu kiten card: вариант — словом до ключей: " +
      "mpu kiten card no-comments id: 1",
    ],
  ];
  await withPolicyFile(async (file) => {
    allowEverything(file);
    for (const [argv, stderr] of cases) {
      await t.step(argv.join(" "), async () => {
        assertEquals(await run(file, argv), {
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      });
    }
  });
});

Deno.test("несовместимые варианты — прежний отказ в новой записи", () =>
  withPolicyFile(async (file) => {
    allowEverything(file);
    const got = await run(file, [
      "logs",
      "portainer",
      "follow",
      "target:",
      "sl-1",
      "service:",
      "api",
    ]);
    assertEquals(got.code, 2);
    assertEquals(
      got.stderr,
      "mpu logs: follow не поддерживается с portainer\n",
    );
  }));

Deno.test("variants — варианты команды, справка — раздел «Варианты»", () =>
  withPolicyFile(async (file) => {
    const listed = await run(file, ["process", "variants"]);
    assertEquals(listed.code, 0, listed.stderr);
    assertEquals(listed.called, []);
    const names = listed.stdout.trimEnd().split("\n").map((row) =>
      row.split("\t")[0]
    );
    for (const name of ["dry", "local", "print", "verbose"]) {
      assertEquals(names.includes(name), true, name);
    }
    assertEquals(names, [...names].sort());
    const chosen = await run(file, ["process", "dry", "variants"]);
    assertEquals(chosen.stdout.includes("dry\t"), false, chosen.stdout);
    const help = await run(file, ["process", "help"]);
    assertStringIncludes(help.stdout, "\n\nВарианты:\n  dry ");
    // Выбор входа занят: второй вариант того же входа не предлагается.
    const via = await run(file, ["logs", "portainer", "variants"]);
    assertEquals(via.stdout.includes("loki\t"), false, via.stdout);
    assertEquals(via.stdout.includes("follow\t"), true, via.stdout);
    const json = await run(file, ["logs", "variants", END, "json"]);
    assertEquals(
      JSON.parse(json.stdout).filter((line: { input: string }) =>
        line.input === "via"
      ).map((line: { selector: string }) => line.selector),
      ["loki", "portainer"],
    );
  }));

Deno.test("вариант не звено пути правил, но слово вопроса двери", (t) =>
  withPolicyFile(async (file) => {
    await t.step("путь правила — прежний", async () => {
      using book = RuleBook.open(file, registrySeeds());
      const outcome = await runChain(
        ["process", "dry", "verbose", "target:", "54"],
        registryRoot(new Captured(), book),
      );
      assertEquals("path" in outcome && outcome.path, ["process", "<args>"]);
    });
    await t.step("команда без ключей: вариант — конец строки", async () => {
      using book = RuleBook.open(file, registrySeeds());
      const line = new Captured();
      await runChain(["kiten", "spaces", "all"], registryRoot(line, book));
      assertEquals(line.argv, ["kiten", "spaces", "--all", "--"]);
    });
    await t.step("справка после варианта — справка команды", async () => {
      const help = await run(file, ["process", "dry", "help"]);
      assertEquals([help.code, help.called], [0, []], help.stderr);
      assertStringIncludes(help.stdout, "Использование: mpu process dry");
    });
    await t.step(
      "mpu ask process dry target: 54 — вопрос с вариантом",
      async () => {
        {
          using book = RuleBook.open(file, registrySeeds());
          book.set(RulePath.parse("process"), ASK);
        }
        const argv = ["ask", "process", "dry", "target:", "54"];
        assertEquals(await run(file, argv, ["n"]), {
          code: 1,
          stdout: "",
          stderr: "выполнить mpu process dry target: 54? [y/N] " +
            "mpu process dry target: 54: не подтверждено\n",
          called: [],
        });
      },
    );
  }));
