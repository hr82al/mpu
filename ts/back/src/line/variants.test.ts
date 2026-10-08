/**
 * Варианты команды (`platform/variants.md`): флаг поведения — унарное
 * сообщение объекту команды до ключей. Пары разбора прежней строки и новой
 * — в `pairs_test.ts`; здесь — отказы, отражение, справка и путь правила.
 * Исполнялась ли команда — по отметке журнала.
 */

import { describe, expect, it } from "vitest";
import type { CommandIo } from "@mpu/command";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { type Outcome, type Report, runChain } from "@mpu/language/objects";
import { ASK, RuleBook, RulePath } from "@mpu/command/policy";
import { makeFakeIo } from "@mpu/command/testing";
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
  const human =
    answers === undefined
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

  consent(report: Report): Promise<Outcome> {
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

describe("вариант не на месте и прежний флаг — отказ с готовой строкой", () => {
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
  for (const [argv, stderr] of cases) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        allowEverything(file);
        expect(await run(file, argv)).toStrictEqual({
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      }),
    );
  }
});

describe("голое слово, которому нет ключа, — лишнее, без готовой строки", () => {
  const cases: readonly (readonly [readonly string[], string])[] = [
    [
      ["kiten", "spaces", "all", "all"],
      "mpu kiten spaces all: лишнее слово all",
    ],
    [
      ["kiten", "spaces", "archived"],
      "mpu kiten spaces: лишнее слово archived",
    ],
    [["logs", "portainer", "loki"], "mpu logs portainer: лишнее слово loki"],
    [
      ["logs", "portainer", "sl-1"],
      "mpu logs portainer: значение — ключом: mpu logs portainer target: sl-1",
    ],
  ];
  for (const [argv, stderr] of cases) {
    it(argv.join(" "), () =>
      withPolicyFile(async (file) => {
        allowEverything(file);
        expect(await run(file, argv)).toStrictEqual({
          code: 2,
          stdout: "",
          stderr: `${stderr}\n`,
          called: [],
        });
      }),
    );
  }
});

it("несовместимые варианты — прежний отказ в новой записи", () =>
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
    expect(got.code).toBe(2);
    expect(got.stderr).toBe("mpu logs: follow не поддерживается с portainer\n");
  }));

it("variants — варианты команды, справка — раздел «Варианты»", () =>
  withPolicyFile(async (file) => {
    const listed = await run(file, ["process", "variants"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.called).toStrictEqual([]);
    const names = listed.stdout
      .trimEnd()
      .split("\n")
      .map((row) => row.split("\t")[0]);
    for (const name of ["dry", "local", "print", "verbose"]) {
      expect(names.includes(name), name).toBe(true);
    }
    expect(names).toStrictEqual([...names].sort());
    const chosen = await run(file, ["process", "dry", "variants"]);
    expect(chosen.stdout.includes("dry\t"), chosen.stdout).toBe(false);
    const help = await run(file, ["process", "help"]);
    expect(help.stdout).toContain("\n\nВарианты:\n  dry ");
    // Выбор входа занят: второй вариант того же входа не предлагается.
    const via = await run(file, ["logs", "portainer", "variants"]);
    expect(via.stdout.includes("loki\t"), via.stdout).toBe(false);
    expect(via.stdout.includes("follow\t"), via.stdout).toBe(true);
    const json = await run(file, ["logs", "variants", END, "json"]);
    expect(
      JSON.parse(json.stdout)
        .filter((line: { input: string }) => line.input === "via")
        .map((line: { selector: string }) => line.selector),
    ).toStrictEqual(["loki", "portainer"]);
  }));

describe("вариант не звено пути правил, но слово вопроса двери", () => {
  it("путь правила — прежний", () =>
    withPolicyFile(async (file) => {
      using book = RuleBook.open(file, registrySeeds());
      const outcome = await runChain(
        ["process", "dry", "verbose", "target:", "54"],
        registryRoot(new Captured(), book),
      );
      expect("path" in outcome && outcome.path).toStrictEqual([
        "process",
        "<args>",
      ]);
    }));
  it("команда без ключей: вариант — конец строки", () =>
    withPolicyFile(async (file) => {
      using book = RuleBook.open(file, registrySeeds());
      const line = new Captured();
      await runChain(["kiten", "spaces", "all"], registryRoot(line, book));
      expect(line.argv).toStrictEqual(["kiten", "spaces", "--all", "--"]);
    }));
  it("справка после варианта — справка команды", () =>
    withPolicyFile(async (file) => {
      const help = await run(file, ["process", "dry", "help"]);
      expect([help.code, help.called], help.stderr).toStrictEqual([0, []]);
      expect(help.stdout).toContain("Использование: mpu process dry");
    }));
  it("mpu ask process dry target: 54 — вопрос с вариантом", () =>
    withPolicyFile(async (file) => {
      {
        using book = RuleBook.open(file, registrySeeds());
        book.set(RulePath.parse("process"), ASK);
      }
      const argv = ["ask", "process", "dry", "target:", "54"];
      expect(await run(file, argv, ["n"])).toStrictEqual({
        code: 1,
        stdout: "",
        stderr:
          "выполнить mpu process dry target: 54? [y/N] " +
          "mpu process dry target: 54: не подтверждено\n",
        called: [],
      });
    }));
});
