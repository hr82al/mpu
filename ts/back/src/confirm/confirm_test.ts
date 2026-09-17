/**
 * Ворота `mpu confirm` (`docs/specs/confirm.md`): эхо, вопрос
 * терминалу и три исхода. Настоящего терминала в тестах нет —
 * подставлен порт.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { CommandIo, TerminalIo } from "../command/mod.ts";
import { DomainError, formatCommandError, UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { confirmCommand } from "./cmd_confirm.ts";
import { echoLine, isYes, ttyDiagnostics } from "./gate.ts";

/** Подставной терминал: помнит вопрос и отдаёт заготовленный ответ. */
function terminal(answer: string | undefined) {
  const asked: string[] = [];
  let closed = false;
  const port: TerminalIo = {
    name: undefined,
    write: (text) => {
      asked.push(text);
      return Promise.resolve();
    },
    readLine: () => Promise.resolve(answer),
    // Скрытого чтения у ворот нет: ответ «да/нет» секретом не бывает.
    readSecret: () => Promise.reject(new Error("readSecret не ожидается")),
    [Symbol.dispose]: () => {
      closed = true;
    },
  };
  return { port, asked, wasClosed: () => closed };
}

/** Окружение ворот: буфер на stdin, терминал и приёмник эха. */
function harness(stdin: string, answer: string | undefined) {
  const tty = terminal(answer);
  const echoed: string[] = [];
  let opened = 0;
  const io: CommandIo = makeFakeIo({
    readStdin: () => Promise.resolve(new TextEncoder().encode(stdin)),
    progress: (line: string) => void echoed.push(line),
    openTerminal: () => {
      opened += 1;
      return Promise.resolve(tty.port);
    },
  });
  return { io, tty, echoed, opened: () => opened };
}

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/confirm/${name}`, import.meta.url),
  );
}

Deno.test("«да»: буфер уходит в stdout как есть", async () => {
  const { io, tty, echoed } = harness('{"ok": true}\n', "y");
  const result = await confirmCommand.invokeInput(
    { message: "Применить?", yes: false },
    io,
  );
  assertEquals(
    confirmCommand.renderResult(result, []),
    await golden("confirm-stdout.txt"),
  );
  assertEquals(echoed, ['{"ok": true}']);
  assertEquals(tty.asked, ["Применить? [y/N] "]);
  assertEquals(tty.wasClosed(), true);
});

Deno.test("вопрос задаётся терминалу, а не stdin", async () => {
  // Ответ приходит из терминала, а в stdin лежит слово «нет»: спутай
  // их — и ворота ответили бы сами себе данными.
  const { io, tty } = harness("нет\n", "yes");
  const result = await confirmCommand.invokeInput(
    { message: "Записать?", yes: false },
    io,
  );
  assertEquals(confirmCommand.renderResult(result, []), "нет\n");
  assertEquals(tty.asked, ["Записать? [y/N] "]);
});

Deno.test("«нет» и конец ввода: отказ, exit 1, stdout пуст", async (t) => {
  for (const answer of ["n", "", "нет", "  ", undefined]) {
    await t.step(`ответ ${JSON.stringify(answer)}`, async () => {
      const { io, tty } = harness("данные\n", answer);
      const err = await assertRejects(
        () =>
          confirmCommand.invokeInput({ message: "Применить?", yes: false }, io),
        DomainError,
      );
      assertEquals(
        `${formatCommandError("confirm", err)}\n`,
        await golden("err-cancelled-stderr.txt"),
      );
      assertEquals(tty.wasClosed(), true);
    });
  }
});

Deno.test("терминала нет: отказ с диагностикой, exit 2", async () => {
  const echoed: string[] = [];
  const io = makeFakeIo({
    readStdin: () => Promise.resolve(new TextEncoder().encode("данные\n")),
    progress: (line: string) => void echoed.push(line),
    openTerminal: () => Promise.resolve(undefined),
  });
  const err = await assertRejects(
    () => confirmCommand.invokeInput({ message: "Применить?", yes: false }, io),
    UsageError,
  );
  assertEquals(
    `${formatCommandError("confirm", err)}\n`,
    await golden("err-no-tty-stderr.txt"),
  );
  // Эхо предшествует отказу и на этой ветке: человек видит, что именно
  // осталось непропущенным (спека, «Golden-примеры»).
  assertEquals(echoed, ["данные"]);
});

Deno.test("--yes: эхо есть, вопроса нет, терминал не открывается", async () => {
  const { io, tty, echoed, opened } = harness("данные\n", undefined);
  const result = await confirmCommand.invokeInput(
    { message: "Применить?", yes: true },
    io,
  );
  assertEquals(confirmCommand.renderResult(result, []), "данные\n");
  // Эхо печатается и в скриптовом режиме: оператор видит, что прошло
  // по конвейеру. Молчание здесь было бы регрессом.
  assertEquals(echoed, ["данные"]);
  assertEquals(tty.asked, []);
  // Именно не открывается: закрытый молча терминал выглядел бы так же.
  assertEquals(opened(), 0);
});

Deno.test("пустой буфер — не ошибка: вопрос задаётся и на нём", async () => {
  const { io, tty, echoed } = harness("", "y");
  const result = await confirmCommand.invokeInput(
    { message: "Применить?", yes: false },
    io,
  );
  assertEquals(confirmCommand.renderResult(result, []), "");
  assertEquals(echoed, [""]);
  assertEquals(tty.asked, ["Применить? [y/N] "]);
});

Deno.test("буфер без перевода строки: эхо с переводом, stdout без", async () => {
  const { io, echoed } = harness("хвост без перевода", "y");
  const result = await confirmCommand.invokeInput(
    { message: "Применить?", yes: false },
    io,
  );
  // Перевод строки печати добавляет точка входа: `progress` печатает
  // строку. В stdout уходит исходный буфер, без него.
  assertEquals(echoed, ["хвост без перевода"]);
  assertEquals(confirmCommand.renderResult(result, []), "хвост без перевода");
});

Deno.test("разбор ответа: «да» — только y и yes", async (t) => {
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
    await t.step(`${JSON.stringify(answer)} → ${expected}`, () => {
      assertEquals(isYes(answer), expected);
    });
  }
});

Deno.test("эхо снимает ровно один перевод строки", () => {
  assertEquals(echoLine("строка\n"), "строка");
  assertEquals(echoLine("строка"), "строка");
  assertEquals(echoLine("строка\n\n"), "строка\n");
});

Deno.test("диагностика называет все три fd и отсутствие ttyname", () => {
  const text = ttyDiagnostics({
    stdinIsTerminal: () => false,
    stdoutIsTerminal: () => true,
    stderrIsTerminal: () => true,
  });
  assertStringIncludes(text, "fd 0 (stdin): isatty=false");
  assertStringIncludes(text, "fd 1 (stdout): isatty=true");
  assertStringIncludes(text, "fd 2 (stderr): isatty=true");
  assertStringIncludes(text, "ttyname в Deno нет");
});
