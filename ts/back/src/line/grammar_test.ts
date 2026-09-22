/**
 * Строка как выражение на дереве реестра (`platform/line-grammar.md`):
 * открытие и закрытие группы, формат данных, справка — сообщение `help`.
 * Исполнялась ли команда — по отметке журнала.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { commands, groups, surfaces } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
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
  const code = await lineEntry(consentOf(file))(argv, makeFakeIo(), {
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
  }, journal);
  return { code, stdout: out.join(""), stderr: err.join(""), called };
}

/** Читающая команда, исполнимая без сети и с отметкой журнала. */
const READING = ["xlsx", "alias", "ls", GRAMMAR.close, "json"];

Deno.test("do … end у хвостовой команды — та же строка, что без них", () =>
  withPolicyFile(async (file) => {
    const plain = await run(file, READING);
    assertEquals(plain.code, 0, plain.stderr);
    for (const line of [[...READING, END], [DO, ...READING, END]]) {
      assertEquals(await run(file, line), plain, line.join(" "));
    }
  }));

Deno.test("данные после end понимают json", () =>
  withPolicyFile(async (file) => {
    const listed = JSON.parse((await run(file, ["policy"])).stdout);
    const json = await run(file, ["policy", END, "json"]);
    assertEquals(json.code, 0);
    assertEquals(json.stdout, `${JSON.stringify(listed, null, 2)}\n`);
    assertEquals(await run(file, ["policy", END, "xml"]), {
      code: 2,
      stdout: "",
      stderr: `mpu policy ${END}: не понимает xml; есть: json\n`,
      called: [],
    });
  }));

Deno.test("help — последним словом, ничего не исполняет", () =>
  withPolicyFile(async (file) => {
    for (
      const line of [["kiten", "card", "help"], ["kiten", "ls", "help"]]
    ) {
      const help = await run(file, line);
      assertEquals(help.code, 0, line.join(" "));
      assertEquals(help.called, [], line.join(" "));
      assert(help.stdout.startsWith("Использование: mpu kiten "), help.stdout);
    }
    assertEquals(await run(file, ["help", "kiten", "card"]), {
      code: 2,
      stdout: "",
      stderr: "mpu help: не понимает kiten; справка — последним словом: " +
        "mpu kiten card help\n",
      called: [],
    });
  }));

Deno.test("справка end json — объект-справка", () =>
  withPolicyFile(async (file) => {
    const help = await run(file, ["kiten", "help", END, "json"]);
    assertEquals(help.code, 0, help.stderr);
    const data = JSON.parse(help.stdout);
    assertEquals(data.path, "mpu kiten");
    assertEquals(
      Object.keys(data).sort(),
      ["examples", "formats", "keys", "messages", "path", "purpose", "text"],
    );
    assert(help.stdout.endsWith("}\n"));
    assertStringIncludes(
      JSON.stringify(data.messages),
      '"selector":"ls"',
    );
  }));

Deno.test("do не первым словом — отказ", () =>
  withPolicyFile(async (file) => {
    assertEquals(await run(file, ["kiten", DO]), {
      code: 2,
      stdout: "",
      stderr: `${DO} — только в начале строки\n`,
      called: [],
    });
  }));

Deno.test("строка диспетчеризации: свой хвост — до закрытия, чужой — целиком", () => {
  const line = [DO, "kiten", "comment", "55", LITERAL, END, END, "json"];
  assertEquals(OWN.argv(line), ["kiten", "comment", "55", LITERAL, END]);
  assertEquals(FOREIGN.argv(line), line.slice(1));
});

Deno.test("справка результата, справка справки, повторное закрытие", () =>
  withPolicyFile(async (file) => {
    const result = await run(file, ["policy", END, "help"]);
    assertEquals(result.code, 0, result.stderr);
    assert(
      result.stdout.startsWith(`Использование: mpu policy ${END} <сообщение>`),
      result.stdout,
    );
    assertStringIncludes(result.stdout, "  json  результат как JSON\n");
    const again = await run(file, ["kiten", "help", "help"]);
    assertEquals(again.code, 0, again.stderr);
    assert(again.stdout.startsWith("mpu kiten help\n\nсправка объекта\n"));
    const plain = await run(file, ["kiten", "help", END]);
    assertEquals(plain.stdout, (await run(file, ["kiten", "help"])).stdout);
    const json = (await run(file, ["policy", END, "json"])).stdout;
    assertEquals(
      (await run(file, ["policy", END, "json", END, "json"])).stdout,
      `${JSON.stringify(json, null, 2)}\n`,
    );
  }));

Deno.test("формат результата: json — прежний JSON, чужой — отказ до исполнения", () =>
  withPolicyFile(async (file) => {
    const line = ["xlsx", "alias", "ls"];
    const json = await run(file, [...line, END, "json"]);
    assertEquals(JSON.parse(json.stdout), { aliases: [] });
    assertEquals(json.called, ["xlsx alias ls"]);
    assertEquals(await run(file, [...line, END, "xml"]), {
      code: 2,
      stdout: "",
      stderr: `mpu xlsx alias ls ${END}: не понимает xml; есть: json\n`,
      called: [],
    });
    assertEquals(await run(file, [...line, END, "json", "md"]), {
      code: 2,
      stdout: "",
      stderr: `mpu xlsx alias ls ${END} json: не понимает md\n`,
      called: [],
    });
  }));

Deno.test("код завершения один с форматом и без", () =>
  withPolicyFile(async (file) => {
    // Путь к книге не задан: текст завершается кодом 2 (`specs/xlsx.md`).
    const text = await run(file, ["xlsx", "resolve"]);
    assertEquals(text.code, 2, text.stderr);
    assertEquals((await run(file, ["xlsx", "resolve", END, "json"])).code, 2);
    assertEquals((await run(file, ["xlsx", "resolve", "--json"])).code, 2);
  }));

Deno.test("слова грамматики зарезервированы: так не зовут ни узел, ни ключ, ни формат", () => {
  const reserved = new Set<string>([DO, END]);
  const names = [
    ...[...commands, ...surfaces, ...groups].flatMap((node) => node.path),
    ...commands.flatMap((command) => [
      ...Object.keys(command.keys ?? {}),
      ...command.inputs.map((input) => input.name),
      ...Object.keys(command.formats),
    ]),
  ];
  assert(names.length > 300, `имён ${names.length}`);
  assertEquals(names.filter((name) => reserved.has(name)), []);
});
