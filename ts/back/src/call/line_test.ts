/**
 * Сценарии 173a на уровне строки (`docs/specs/call.md`): отказ реестра
 * чтения (A7), дверь `ask` (A8, A9), посев правил (A19), сообщения
 * получателя по взглядам (A20) и справки — голденами. Ни одна строка
 * здесь не доходит до сети: отказы случаются раньше, а на вопрос двери
 * человек отвечает «нет».
 */

import { assertEquals } from "@std/assert";
import type { InvokeJournal } from "../entrypoint/mod.ts";
import { lineEntry } from "../line/mod.ts";
import { consentOf, withPolicyFile } from "../line/testconsent.ts";
import { GRAMMAR } from "../messages/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Пути команд, дошедших до исполнения. */
  readonly called: readonly string[];
}

/** Одна строка — один процесс; ответы есть — канал с человеком. */
async function run(
  file: string,
  words: readonly string[],
  answers?: readonly string[],
): Promise<Ran> {
  let stdout = "";
  let stderr = "";
  const called: string[] = [];
  const journal = {
    nativeCall: (command: { readonly path: readonly string[] }) =>
      void called.push(command.path.join(" ")),
    note: () => {},
  } as unknown as InvokeJournal;
  const human = answers === undefined
    ? {}
    : { stdinIsTerminal: () => true, stderrIsTerminal: () => true };
  const io = makeFakeIo({
    readStdin: () => Promise.resolve(new Uint8Array()),
    ...human,
  });
  const code = await lineEntry(consentOf(file, answers))(words, io, {
    stdout: (text: string) => void (stdout += text),
    stderr: (text: string) => void (stderr += text),
  }, journal);
  return { code, stdout, stderr, called };
}

const IMPORT = ["target:", "54", "path:", "/v1/product/import"];

Deno.test("A7: call-ro вне реестра — отказ с готовой строкой записи", () =>
  withPolicyFile(async (file) => {
    const ran = await run(file, ["ozon", "call-ro", ...IMPORT]);
    assertEquals([ran.code, ran.stdout, ran.stderr], [
      2,
      "",
      "mpu ozon call-ro: ручки POST /v1/product/import нет в списке " +
      "чтения — запись: mpu ask ozon call target: 54 path: /v1/product/import\n",
    ]);
  }));

Deno.test("A8: call без двери — отказ двери, команда не исполнялась", () =>
  withPolicyFile(async (file) => {
    assertEquals(await run(file, ["ozon", "call", ...IMPORT], ["y"]), {
      code: 2,
      stdout: "",
      stderr: "mpu ozon call target: 54 path: /v1/product/import: требует " +
        "подтверждения — вызывай mpu ask ozon call target: 54 path: " +
        "/v1/product/import\n",
      called: [],
    });
  }));

Deno.test("A9: call через дверь — вопрос человеку строкой вызова", () =>
  withPolicyFile(async (file) => {
    const line = ["ask", "ozon", "call", ...IMPORT, "body:", '{"items":[]}'];
    const ran = await run(file, line, ["n"]);
    const question = "выполнить mpu ozon call target: 54 path: " +
      '/v1/product/import body: {"items":[]}? [y/N] ';
    assertEquals(ran.stderr.startsWith(question), true, ran.stderr);
    assertEquals(ran.called, []);
  }));

Deno.test("A19: посев — call-ro allow, call ask", () =>
  withPolicyFile(async (file) => {
    const ran = await run(file, ["policy", GRAMMAR.close, "json"]);
    const rules = JSON.parse(ran.stdout) as { path: string; verdict: string }[];
    const ozon = rules.filter((rule) => rule.path.startsWith("ozon call"));
    assertEquals(
      ozon.map(({ path, verdict }) => ({ path, verdict })).sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
      [
        { path: "ozon call", verdict: "ask" },
        { path: "ozon call-ro", verdict: "allow" },
      ],
    );
  }));

Deno.test("A20: сообщения получателя ozon по взглядам двери", () =>
  withPolicyFile(async (file) => {
    const reading = await run(file, ["ozon", "messages"]);
    const writing = await run(file, ["ask", "ozon", "messages"]);
    assertEquals(
      [reading.code, reading.stdout],
      [
        0,
        "call-ro\tчто сейчас отвечает ручка чтения Ozon Seller API под " +
        "ключом кабинета клиента\n",
      ],
    );
    assertEquals(
      [writing.code, writing.stdout],
      [
        0,
        "call\tвызвать любую ручку Ozon Seller API под ключом кабинета " +
        "клиента (запись)\n",
      ],
    );
  }));

Deno.test("справки получателя и сообщений — голдены", () =>
  withPolicyFile(async (file) => {
    const cases: readonly [readonly string[], string][] = [
      [["ozon", "--help"], "help-ozon.txt"],
      [["ozon", "call-ro", "--help"], "help-ozon-call-ro.txt"],
      [["ask", "ozon", "call", "--help"], "help-ozon-call.txt"],
    ];
    for (const [words, name] of cases) {
      const golden = await Deno.readTextFile(
        new URL(`testdata/${name}`, import.meta.url),
      );
      const ran = await run(file, words);
      assertEquals([ran.code, ran.stdout], [0, golden], name);
    }
  }));
