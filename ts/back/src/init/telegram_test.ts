/**
 * Шаг входа `mpu init` при сбое криптографии: шаг best-effort, поэтому
 * отказ по-прежнему печатается пропуском (`docs/specs/telegram-login.md`,
 * инвариант 3), но причина в нём — текст спеки, а не обёртка операции
 * (`platform/telegram-mtproto.md`, «Конфигурация»). До сети дело не доходит.
 */

import { assertEquals } from "@std/assert";
import type { EnvFile } from "../command/mod.ts";
import { makeFakeIo, promptAnswering } from "../testing/mod.ts";
import { runTelegramLogin } from "./telegram.ts";

Deno.test("вход при init: сбой криптографии — пропуск с текстом спеки", async () => {
  // Ключи и телефон уже в env-файле: вопросов человеку нет, и сценарий
  // сразу доходит до клиента входа.
  const keys: Readonly<Record<string, string>> = {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
    TELEGRAM_PHONE: "+70000000000",
  };
  const envFile: EnvFile = {
    get: (name) => keys[name],
    require: (name) => keys[name] ?? "",
    set: () => Promise.reject(new Error("вход не должен ничего записывать")),
    values: () => ({ ...keys }),
  };
  const progress: string[] = [];
  const realReadFile = Deno.readFile;
  Deno.readFile = () =>
    Promise.reject(new Deno.errors.NotFound("нет встроенного модуля"));
  try {
    const reason = await runTelegramLogin(makeFakeIo({
      envFile,
      // Человек за терминалом есть, но отвечает пустым: вход дойдёт до
      // ленивой загрузки криптографии, а она и проверяется.
      prompt: promptAnswering({ line: "", secret: "" }),
      progress: (line) => void progress.push(line),
    }));
    const text =
      "telegram: криптография клиента не поднялась: нет встроенного модуля";
    assertEquals(reason, text);
    assertEquals(progress.at(-1), `# telegram: пропущено (${text})`);
  } finally {
    Deno.readFile = realReadFile;
  }
});
