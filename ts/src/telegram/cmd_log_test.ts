/**
 * Команда `mpu telegram log` (`docs/specs/telegram-log.md`): разбор
 * ввода. Сеть не задействована — проверяется всё, что решается до неё.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Command } from "../command/mod.ts";
import { formatCommandError, VerbatimUsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { logText, telegramLogCommand } from "./cmd_log.ts";

const command: Command = telegramLogCommand;

/** Порт чтения stdin: команда читает его только при MESSAGE = '-'. */
function io(stdin: string): { readStdin: () => Promise<Uint8Array> } {
  return { readStdin: () => Promise.resolve(new TextEncoder().encode(stdin)) };
}

/** Голден канала: копия лежит рядом с тестом (`testdata/telegram-log/`). */
async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-log/${name}`, import.meta.url),
  );
}

Deno.test("обычный текст берётся из аргумента, stdin не читается", async () => {
  let read = false;
  const text = await logText({ message: "заметка" }, {
    readStdin: () => {
      read = true;
      return Promise.resolve(new Uint8Array());
    },
  });
  assertEquals(text, "заметка");
  assertEquals(read, false);
});

Deno.test("дефис означает весь stdin", async () => {
  const text = await logText({ message: "-" }, io("две\nстроки\n"));
  assertEquals(text, "две\nстроки\n");
});

Deno.test("пустой аргумент — ошибка ввода", async () => {
  await assertRejects(
    () => logText({ message: "" }, io("")),
    VerbatimUsageError,
    "нужен непустой MESSAGE",
  );
});

Deno.test("пустой stdin — та же ошибка ввода", async () => {
  await assertRejects(
    () => logText({ message: "-" }, io("   \n")),
    VerbatimUsageError,
    "нужен непустой MESSAGE",
  );
});

Deno.test("строка вывода: заметка отправлена", async () => {
  assertEquals(
    command.renderResult({ id: 5000001 }, ["заметка"]),
    await golden("log-stdout.txt"),
  );
});

Deno.test("пустой текст — отказ до сети", async () => {
  const err = await assertRejects(
    () => command.invoke([""], makeFakeIo()),
    VerbatimUsageError,
  );
  assertEquals(err.message, "telegram: нужен непустой MESSAGE");
  assertEquals(`${err.message}\n`, await golden("err-empty-text-stderr.txt"));
});

Deno.test("строка stderr идёт без префикса команды", async () => {
  const err = await assertRejects(
    () => command.invoke([""], makeFakeIo()),
    VerbatimUsageError,
  );
  // Форму строки задаёт слой (`telegram: <причина>`), а не точка входа:
  // общий префикс `mpu telegram log: ` развалил бы голден.
  assertEquals(
    `${formatCommandError(command.errorName, err)}\n`,
    await golden("err-empty-text-stderr.txt"),
  );
});
