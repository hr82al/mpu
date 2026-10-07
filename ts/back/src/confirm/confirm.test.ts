/**
 * Ворота `mpu confirm` (`docs/specs/confirm.md`): эхо, вопрос
 * терминалу и три исхода. Настоящего терминала в тестах нет —
 * подставлен порт.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { type CommandIo, NO_ONE, type Prompt } from "../command/mod.ts";
import { DomainError, formatCommandError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { confirmCommand } from "./cmd_confirm.ts";
import { echoLine, isYes, ttyDiagnostics } from "./gate.ts";

/** Подставной спрошенный: помнит вопрос и отдаёт заготовленный ответ. */
function terminal(answer: string | undefined) {
  const asked: string[] = [];
  let opened = 0;
  const port: Prompt = {
    line: (question, reply) => {
      opened += 1;
      asked.push(question);
      // Конец ввода — пустой ответ: человека спросили, он промолчал.
      return Promise.resolve(reply.given(answer ?? ""));
    },
    // Скрытого вопроса у ворот нет: ответ «да/нет» секретом не бывает.
    secret: () => Promise.reject(new Error("secret не ожидается")),
    copy: () => Promise.reject(new Error("copy не ожидается")),
  };
  return { port, asked, opened: () => opened };
}

/** Окружение ворот: буфер на stdin, спрошенный и приёмник эха. */
function harness(stdin: string, answer: string | undefined) {
  const tty = terminal(answer);
  const echoed: string[] = [];
  const io: CommandIo = makeFakeIo({
    readStdin: () => Promise.resolve(new TextEncoder().encode(stdin)),
    progress: (line: string) => void echoed.push(line),
    prompt: tty.port,
  });
  return { io, tty, echoed, opened: tty.opened };
}

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/confirm/${name}`, import.meta.url),
    "utf8",
  );
}

it("«да»: буфер уходит в stdout как есть", async () => {
  const { io, tty, echoed } = harness('{"ok": true}\n', "y");
  const result = await confirmCommand.invokeInput(
    { message: "Применить?", yes: false },
    io,
  );
  expect(confirmCommand.renderResult(result, [])).toStrictEqual(
    await golden("confirm-stdout.txt"),
  );
  expect(echoed).toStrictEqual(['{"ok": true}']);
  expect(tty.asked).toStrictEqual(["Применить? [y/N] "]);
  expect(tty.opened()).toBe(1);
});

it("вопрос задаётся терминалу, а не stdin", async () => {
  // Ответ приходит из терминала, а в stdin лежит слово «нет»: спутай
  // их — и ворота ответили бы сами себе данными.
  const { io, tty } = harness("нет\n", "yes");
  const result = await confirmCommand.invokeInput(
    { message: "Записать?", yes: false },
    io,
  );
  expect(confirmCommand.renderResult(result, [])).toBe("нет\n");
  expect(tty.asked).toStrictEqual(["Записать? [y/N] "]);
});

describe("«нет» и конец ввода: отказ, exit 1, stdout пуст", () => {
  for (const answer of ["n", "", "нет", "  ", undefined]) {
    it(`ответ ${JSON.stringify(answer)}`, async () => {
      const { io, tty } = harness("данные\n", answer);
      const err = await rejected(
        () =>
          confirmCommand.invokeInput({ message: "Применить?", yes: false }, io),
        DomainError,
      );
      expect(`${formatCommandError("confirm", err)}\n`).toStrictEqual(
        await golden("err-cancelled-stderr.txt"),
      );
      expect(tty.opened()).toBe(1);
    });
  }
});

it("терминала нет: отказ с диагностикой, exit 2", async () => {
  const echoed: string[] = [];
  const io = makeFakeIo({
    readStdin: () => Promise.resolve(new TextEncoder().encode("данные\n")),
    progress: (line: string) => void echoed.push(line),
    prompt: NO_ONE,
  });
  const err = await rejected(
    () => confirmCommand.invokeInput({ message: "Применить?", yes: false }, io),
    UsageError,
  );
  expect(`${formatCommandError("confirm", err)}\n`).toStrictEqual(
    await golden("err-no-tty-stderr.txt"),
  );
  // Эхо предшествует отказу и на этой ветке: человек видит, что именно
  // осталось непропущенным (спека, «Golden-примеры»).
  expect(echoed).toStrictEqual(["данные"]);
});

it("--yes: эхо есть, вопроса нет, терминал не открывается", async () => {
  const { io, tty, echoed, opened } = harness("данные\n", undefined);
  const result = await confirmCommand.invokeInput(
    { message: "Применить?", yes: true },
    io,
  );
  expect(confirmCommand.renderResult(result, [])).toBe("данные\n");
  // Эхо печатается и в скриптовом режиме: оператор видит, что прошло
  // по конвейеру. Молчание здесь было бы регрессом.
  expect(echoed).toStrictEqual(["данные"]);
  expect(tty.asked).toStrictEqual([]);
  // Именно не открывается: закрытый молча терминал выглядел бы так же.
  expect(opened()).toBe(0);
});

it("пустой буфер — не ошибка: вопрос задаётся и на нём", async () => {
  const { io, tty, echoed } = harness("", "y");
  const result = await confirmCommand.invokeInput(
    { message: "Применить?", yes: false },
    io,
  );
  expect(confirmCommand.renderResult(result, [])).toBe("");
  expect(echoed).toStrictEqual([""]);
  expect(tty.asked).toStrictEqual(["Применить? [y/N] "]);
});

it("буфер без перевода строки: эхо с переводом, stdout без", async () => {
  const { io, echoed } = harness("хвост без перевода", "y");
  const result = await confirmCommand.invokeInput(
    { message: "Применить?", yes: false },
    io,
  );
  // Перевод строки печати добавляет точка входа: `progress` печатает
  // строку. В stdout уходит исходный буфер, без него.
  expect(echoed).toStrictEqual(["хвост без перевода"]);
  expect(confirmCommand.renderResult(result, [])).toBe("хвост без перевода");
});

describe("разбор ответа: «да» — только y и yes", () => {
  const cases: readonly (readonly [string | undefined, boolean])[] = [
    ["y", true],
    ["Y", true],
    ["yes", true],
    [" YES ", true],
    ["n", false],
    ["", false],
    ["yep", false],
    ["да", false],
    [undefined, false],
  ];
  for (const [answer, expected] of cases) {
    it(`${JSON.stringify(answer)} → ${expected}`, () => {
      expect(isYes(answer)).toStrictEqual(expected);
    });
  }
});

it("эхо снимает ровно один перевод строки", () => {
  expect(echoLine("строка\n")).toBe("строка");
  expect(echoLine("строка")).toBe("строка");
  expect(echoLine("строка\n\n")).toBe("строка\n");
});

it("диагностика называет все три fd и отсутствие ttyname", () => {
  const text = ttyDiagnostics({
    stdinIsTerminal: () => false,
    stdoutIsTerminal: () => true,
    stderrIsTerminal: () => true,
  });
  expect(text).toContain("fd 0 (stdin): isatty=false");
  expect(text).toContain("fd 1 (stdout): isatty=true");
  expect(text).toContain("fd 2 (stderr): isatty=true");
  expect(text).toContain("ttyname в Deno нет");
});
