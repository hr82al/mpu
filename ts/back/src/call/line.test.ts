/**
 * Сценарии 173a–173c на уровне строки (`docs/specs/call.md`): отказ реестра
 * чтения (A7), дверь `ask` (A8, A9), посев правил (A19), сообщения
 * получателя по взглядам (A20) и справки — голденами. Ни одна строка
 * здесь не доходит до сети: отказы случаются раньше, а на вопрос двери
 * человек отвечает «нет».
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
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

/** Строка подгруппы `perf` в сообщениях получателя `ozon` (B9). */
const PERF_LINE = "perf\tOzon Performance API (реклама) под ключами " +
  "кабинета клиента: call-ro | call\n";

it("A7: call-ro вне реестра — отказ с готовой строкой записи", () =>
  withPolicyFile(async (file) => {
    const ran = await run(file, ["ozon", "call-ro", ...IMPORT]);
    expect([ran.code, ran.stdout, ran.stderr]).toStrictEqual([
      2,
      "",
      "mpu ozon call-ro: ручки POST /v1/product/import нет в списке " +
      "чтения — запись: mpu ask ozon call target: 54 path: /v1/product/import\n",
    ]);
  }));

it("A8: call без двери — отказ двери, команда не исполнялась", () =>
  withPolicyFile(async (file) => {
    expect(await run(file, ["ozon", "call", ...IMPORT], ["y"])).toStrictEqual({
      code: 2,
      stdout: "",
      stderr: "mpu ozon call target: 54 path: /v1/product/import: требует " +
        "подтверждения — вызывай mpu ask ozon call target: 54 path: " +
        "/v1/product/import\n",
      called: [],
    });
  }));

it("A9: call через дверь — вопрос человеку строкой вызова", () =>
  withPolicyFile(async (file) => {
    const line = ["ask", "ozon", "call", ...IMPORT, "body:", '{"items":[]}'];
    const ran = await run(file, line, ["n"]);
    const question = "выполнить mpu ozon call target: 54 path: " +
      '/v1/product/import body: {"items":[]}? [y/N] ';
    expect(ran.stderr.startsWith(question), ran.stderr).toBe(true);
    expect(ran.called).toStrictEqual([]);
  }));

it("A19, посев 173b: call-ro allow, call ask — у обоих получателей", () =>
  withPolicyFile(async (file) => {
    const ran = await run(file, ["policy", GRAMMAR.close, "json"]);
    const rules = JSON.parse(ran.stdout) as { path: string; verdict: string }[];
    const ozon = rules.filter((rule) => /^ozon (perf )?call/.test(rule.path));
    expect(
      ozon.map(({ path, verdict }) => ({ path, verdict })).sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
    ).toStrictEqual([
      { path: "ozon call", verdict: "ask" },
      { path: "ozon call-ro", verdict: "allow" },
      { path: "ozon perf call", verdict: "ask" },
      { path: "ozon perf call-ro", verdict: "allow" },
    ]);
  }));

it("A20, B9: сообщения получателя ozon по взглядам двери", () =>
  withPolicyFile(async (file) => {
    const reading = await run(file, ["ozon", "messages"]);
    const writing = await run(file, ["ask", "ozon", "messages"]);
    expect([reading.code, reading.stdout]).toStrictEqual([
      0,
      "call-ro\tчто сейчас отвечает ручка чтения Ozon Seller API под " +
      "ключом кабинета клиента\n" + PERF_LINE,
    ]);
    expect([writing.code, writing.stdout]).toStrictEqual([
      0,
      "call\tвызвать любую ручку Ozon Seller API под ключом кабинета " +
      "клиента (запись)\n" + PERF_LINE,
    ]);
  }));

it("справки получателя и сообщений — голдены", () =>
  withPolicyFile(async (file) => {
    const cases: readonly [readonly string[], string][] = [
      [["ozon", "--help"], "help-ozon.txt"],
      [["ozon", "call-ro", "--help"], "help-ozon-call-ro.txt"],
      [["ask", "ozon", "call", "--help"], "help-ozon-call.txt"],
      [["ozon", "perf", "--help"], "help-ozon-perf.txt"],
      [["ozon", "perf", "call-ro", "--help"], "help-ozon-perf-call-ro.txt"],
      [["ask", "ozon", "perf", "call", "--help"], "help-ozon-perf-call.txt"],
      [["wb", "--help"], "help-wb.txt"],
      [["wb", "call-ro", "--help"], "help-wb-call-ro.txt"],
      [["ask", "wb", "call", "--help"], "help-wb-call.txt"],
    ];
    for (const [words, name] of cases) {
      const golden = await readFile(
        new URL(`testdata/${name}`, import.meta.url),
        "utf8",
      );
      const ran = await run(file, words);
      expect([ran.code, ran.stdout], name).toStrictEqual([0, golden]);
    }
  }));

it("B7: perf call-ro вне реестра — отказ с готовой строкой записи", () =>
  withPolicyFile(async (file) => {
    const path = ["path:", "/api/client/campaign/1/activate"];
    const ran = await run(file, [
      "ozon",
      "perf",
      "call-ro",
      "target:",
      "54",
      ...path,
    ]);
    expect([ran.code, ran.stdout, ran.stderr]).toStrictEqual([
      2,
      "",
      "mpu ozon perf call-ro: ручки GET /api/client/campaign/1/activate нет " +
      "в списке чтения — запись: mpu ask ozon perf call target: 54 path: " +
      "/api/client/campaign/1/activate\n",
    ]);
  }));

it("perf call без двери — отказ двери, команда не исполнялась", () =>
  withPolicyFile(async (file) => {
    const line = ["ozon", "perf", "call", "target:", "54", "path:", "/x"];
    const ran = await run(file, line, ["y"]);
    expect([ran.code, ran.called]).toStrictEqual([2, []]);
    expect(ran.stderr).toStrictEqual(
      "mpu ozon perf call target: 54 path: /x: требует подтверждения — " +
        "вызывай mpu ask ozon perf call target: 54 path: /x\n",
    );
  }));

const CARDS = [
  "target:",
  "57",
  "url:",
  "https://content-api.wildberries.ru/content/v2/get/cards/list",
];

it("W3: wb call-ro вне реестра — отказ с хостом и строкой записи", () =>
  withPolicyFile(async (file) => {
    const ran = await run(file, ["wb", "call-ro", ...CARDS]);
    expect([ran.code, ran.stdout, ran.stderr]).toStrictEqual([
      2,
      "",
      "mpu wb call-ro: ручки GET content-api.wildberries.ru/content/v2/get/" +
      "cards/list нет в списке чтения — запись: mpu ask wb call target: 57 " +
      "url: https://content-api.wildberries.ru/content/v2/get/cards/list\n",
    ]);
  }));

it("W5: wb call-ro, хост вне таблицы — отказ до всего", () =>
  withPolicyFile(async (file) => {
    const line = [
      "wb",
      "call-ro",
      "target:",
      "57",
      "url:",
      "https://example.com/x",
    ];
    const ran = await run(file, line);
    expect([ran.code, ran.stdout, ran.stderr]).toStrictEqual([
      2,
      "",
      "mpu wb call-ro: хост example.com не из API Wildberries\n",
    ]);
  }));

it("W2, W4: wb call — только дверью ask, вопрос строкой вызова", () =>
  withPolicyFile(async (file) => {
    const refused = await run(file, ["wb", "call", ...CARDS], ["y"]);
    expect([refused.code, refused.called]).toStrictEqual([2, []]);
    expect(refused.stderr).toStrictEqual(
      `mpu wb call ${CARDS.join(" ")}: требует подтверждения — вызывай ` +
        `mpu ask wb call ${CARDS.join(" ")}\n`,
    );
    const asked = await run(file, [
      "ask",
      "wb",
      "call",
      ...CARDS,
      "body:",
      "{}",
    ], [
      "n",
    ]);
    const question = `выполнить mpu wb call ${
      CARDS.join(" ")
    } body: {}? [y/N] `;
    expect(asked.stderr.startsWith(question), asked.stderr).toBe(true);
    expect(asked.called).toStrictEqual([]);
  }));

it("посев 173c: wb call-ro allow, wb call ask", () =>
  withPolicyFile(async (file) => {
    const ran = await run(file, ["policy", GRAMMAR.close, "json"]);
    const rules = JSON.parse(ran.stdout) as { path: string; verdict: string }[];
    const wb = rules.filter((rule) => /^wb call/.test(rule.path));
    expect(
      wb.map(({ path, verdict }) => ({ path, verdict })).sort((a, b) =>
        a.path.localeCompare(b.path)
      ),
    ).toStrictEqual([
      { path: "wb call", verdict: "ask" },
      { path: "wb call-ro", verdict: "allow" },
    ]);
  }));

it("сообщения получателя wb по взглядам двери", () =>
  withPolicyFile(async (file) => {
    const reading = await run(file, ["wb", "messages"]);
    const writing = await run(file, ["ask", "wb", "messages"]);
    expect([reading.code, reading.stdout]).toStrictEqual([
      0,
      "call-ro\tчто сейчас отвечает ручка чтения Wildberries API под токеном " +
      "кабинета клиента\n",
    ]);
    expect([writing.code, writing.stdout]).toStrictEqual([
      0,
      "call\tвызвать любую ручку Wildberries API под токеном кабинета " +
      "клиента (запись)\n",
    ]);
  }));
