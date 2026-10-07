/**
 * Шаг входа `mpu init` при сбое криптографии: шаг best-effort, поэтому
 * отказ по-прежнему печатается пропуском (`docs/specs/telegram-login.md`,
 * инвариант 3), но причина в нём — текст спеки, а не обёртка операции
 * (`platform/telegram-mtproto.md`, «Конфигурация»). До сети дело не доходит.
 */

import { __getWasm } from "@mtcute/wasm";
import { expect, it } from "vitest";
import type { EnvFile } from "../command/mod.ts";
import { makeFakeIo, promptAnswering } from "../testing/mod.ts";
import { runTelegramLogin } from "./telegram.ts";

it("вход при init: сбой криптографии — пропуск с текстом спеки", async () => {
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
  // Сбой «модуль не поднялся» — отказ `new WebAssembly.Module` в `initSync`
  // пакета `@mtcute/wasm`. После первой удачной инициализации `initSync`
  // ничего не делает, поэтому подмена действует лишь пока модуль не
  // поднят: это проверяется до неё, иначе случай ничего не проверит.
  expect(__getWasm(), "модуль уже поднят — случай ничего не проверит")
    .toBe(undefined);
  const realModule = WebAssembly.Module;
  Reflect.set(WebAssembly, "Module", function () {
    throw new Error("нет встроенного модуля");
  });
  let reason: string | null;
  try {
    reason = await runTelegramLogin(makeFakeIo({
      envFile,
      // Человек за терминалом есть, но отвечает пустым: вход дойдёт до
      // ленивой загрузки криптографии, а она и проверяется.
      prompt: promptAnswering({ line: "", secret: "" }),
      progress: (line) => void progress.push(line),
    }));
  } finally {
    Reflect.set(WebAssembly, "Module", realModule);
  }
  const text =
    "telegram: криптография клиента не поднялась: нет встроенного модуля";
  expect(reason).toStrictEqual(text);
  expect(progress.at(-1)).toStrictEqual(`# telegram: пропущено (${text})`);
});
