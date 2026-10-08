/**
 * Строка как выражение на дереве реестра (`platform/line-grammar.md`):
 * открытие и закрытие группы, формат данных, справка — сообщение `help`.
 * Исполнялась ли команда — по отметке журнала.
 */

import { assert, expect, it } from "vitest";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "@mpu/language/messages";
import { commands, groups, surfaces } from "../registry/mod.ts";
import { makeFakeIo } from "@mpu/command/testing";
import { lineEntry } from "./mod.ts";
import { FOREIGN, OWN } from "./order.ts";
import { consentOf, withPolicyFile } from "./testconsent.ts";

const { open: DO, close: END, literal: LITERAL } = GRAMMAR;

async function run(file: string, argv: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const code = await lineEntry(consentOf(file))(
    argv,
    makeFakeIo(),
    {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
    },
    journal,
  );
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

/** Читающая команда, исполнимая без сети и с отметкой журнала. */
const READING = ["xlsx", "alias", "ls", GRAMMAR.close, "json"];

it("do … end у хвостовой команды — та же строка, что без них", () =>
  withPolicyFile(async (file) => {
    const plain = await run(file, READING);
    expect(plain.code, plain.stderr).toBe(0);
    for (const line of [
      [...READING, END],
      [DO, ...READING, END],
    ]) {
      expect(await run(file, line), line.join(" ")).toStrictEqual(plain);
    }
  }));

it("данные после end понимают json и отбор", () =>
  withPolicyFile(async (file) => {
    const listed = JSON.parse((await run(file, ["policy"])).stdout);
    const json = await run(file, ["policy", END, "json"]);
    expect(json.code).toBe(0);
    expect(json.stdout).toStrictEqual(`${JSON.stringify(listed, null, 2)}\n`);
    expect(await run(file, ["policy", END, "xml"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr: `mpu policy ${END} xml: коллекция не понимает xml\n`,
      called: [],
    });
    const size = await run(file, ["policy", END, "size"]);
    expect([size.code, size.stdout]).toStrictEqual([0, `${listed.length}\n`]);
  }));

it("help — последним словом, ничего не исполняет", () =>
  withPolicyFile(async (file) => {
    for (const line of [
      ["kiten", "card", "help"],
      ["kiten", "ls", "help"],
    ]) {
      const help = await run(file, line);
      expect(help.code, line.join(" ")).toBe(0);
      expect(help.called, line.join(" ")).toStrictEqual([]);
      assert(help.stdout.startsWith("Использование: mpu kiten "), help.stdout);
    }
    expect(await run(file, ["help", "kiten", "card"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr:
        "mpu help: не понимает kiten; справка — последним словом: " +
        "mpu kiten card help\n",
      called: [],
    });
  }));

it("справка end json — объект-справка", () =>
  withPolicyFile(async (file) => {
    const help = await run(file, ["kiten", "help", END, "json"]);
    expect(help.code, help.stderr).toBe(0);
    const data = JSON.parse(help.stdout);
    expect(data.path).toBe("mpu kiten");
    expect(Object.keys(data).sort()).toStrictEqual([
      "examples",
      "formats",
      "keys",
      "messages",
      "path",
      "purpose",
      "text",
      "variants",
    ]);
    assert(help.stdout.endsWith("}\n"));
    expect(JSON.stringify(data.messages)).toContain('"selector":"ls"');
  }));

it("do не первым словом — отказ", () =>
  withPolicyFile(async (file) => {
    expect(await run(file, ["kiten", DO])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr: `${DO} — в начале строки или на месте значения\n`,
      called: [],
    });
  }));

it("строка диспетчеризации: свой хвост — до закрытия, чужой — целиком", () => {
  const line = [DO, "kiten", "comment", "55", LITERAL, END, END, "json"];
  expect(OWN.argv(line)).toStrictEqual([
    "kiten",
    "comment",
    "55",
    LITERAL,
    END,
  ]);
  expect(FOREIGN.argv(line)).toStrictEqual(line.slice(1));
});

it("справка результата, справка справки, повторное закрытие", () =>
  withPolicyFile(async (file) => {
    const result = await run(file, ["policy", END, "help"]);
    expect(result.code, result.stderr).toBe(0);
    assert(
      result.stdout.startsWith(`Использование: mpu policy ${END} <сообщение>`),
      result.stdout,
    );
    expect(result.stdout).toMatch(/\n {2}json +результат как JSON\n/);
    expect(result.stdout).toMatch(/\n {2}size +число элементов\n/);
    const again = await run(file, ["kiten", "help", "help"]);
    expect(again.code, again.stderr).toBe(0);
    assert(again.stdout.startsWith("mpu kiten help\n\nсправка объекта\n"));
    const plain = await run(file, ["kiten", "help", END]);
    expect(plain.stdout).toStrictEqual(
      (await run(file, ["kiten", "help"])).stdout,
    );
    const json = (await run(file, ["policy", END, "json"])).stdout;
    expect(
      (await run(file, ["policy", END, "json", END, "json"])).stdout,
    ).toStrictEqual(`${JSON.stringify(json, null, 2)}\n`);
  }));

it("формат результата: json — прежний JSON, чужой — отказ до исполнения", () =>
  withPolicyFile(async (file) => {
    const line = ["xlsx", "alias", "ls"];
    const json = await run(file, [...line, END, "json"]);
    expect(JSON.parse(json.stdout)).toStrictEqual({ aliases: [] });
    expect(json.called).toStrictEqual(["xlsx alias ls"]);
    expect(await run(file, [...line, END, "xml"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr:
        `mpu xlsx alias ls ${END}: не понимает xml; есть: json, ` +
        "first, first:, isEmpty, last, last:, pick:, size, sortBy:, where:\n",
      called: [],
    });
    expect(await run(file, [...line, END, "json", "md"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr: `mpu xlsx alias ls ${END} json: не понимает md\n`,
      called: [],
    });
  }));

it("код завершения один с форматом и без", () =>
  withPolicyFile(async (file) => {
    // Путь к книге не задан: текст завершается кодом 2 (`specs/xlsx.md`).
    const text = await run(file, ["xlsx", "resolve"]);
    expect(text.code, text.stderr).toBe(2);
    expect((await run(file, ["xlsx", "resolve", END, "json"])).code).toBe(2);
    expect((await run(file, ["xlsx", "resolve", "--json"])).code).toBe(2);
  }));

it("слова грамматики зарезервированы: так не зовут ни узел, ни ключ, ни формат", () => {
  // Узел и формат пишутся голым словом — им нельзя ни одно слово
  // грамматики, и строки, и программы (`platform/evaluator.md`). Ключ
  // пишется `имя:` или `--имя` — другим словом, чем голое слово
  // программы (`done:` у `kiten close` блок не закрывает); ему нельзя
  // только слова строки.
  const everyWord = new Set<string>(Object.values(GRAMMAR));
  const lineWords = new Set<string>([DO, END]);
  const bare = [
    ...[...commands, ...surfaces, ...groups].flatMap((node) => node.path),
    ...commands.flatMap((command) => Object.keys(command.formats)),
  ];
  const keys = commands.flatMap((command) => [
    ...Object.keys(command.keys ?? {}),
    ...command.inputs.map((input) => input.name),
  ]);
  assert(bare.length + keys.length > 300, `имён ${bare.length + keys.length}`);
  expect(bare.filter((name) => everyWord.has(name))).toStrictEqual([]);
  expect(keys.filter((name) => lineWords.has(name))).toStrictEqual([]);
});
