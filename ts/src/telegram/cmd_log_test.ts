/**
 * Команда `mpu telegram log` (`docs/specs/telegram-log.md`): разбор
 * ввода. Сеть не задействована — проверяется всё, что решается до неё.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { VerbatimUsageError } from "../command/mod.ts";
import { logText } from "./cmd_log.ts";

/** Порт чтения stdin: команда читает его только при MESSAGE = '-'. */
function io(stdin: string): { readStdin: () => Promise<Uint8Array> } {
  return { readStdin: () => Promise.resolve(new TextEncoder().encode(stdin)) };
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
