/**
 * Отказы `@mpu/telegram` у слоя команд (`docs/specs/platform/
 * telegram-mtproto.md`, «Ошибки и коды выхода»): отказ слоя уходит классом
 * контракта команды — код 1 и строка `telegram: …` без префикса команды; у
 * ошибки ввода — код 2; дефект — тем же объектом. Здесь — коды и строки
 * через точку входа; перевод отказа классом проверяет пакет
 * `@mpu/cmd-telegram`.
 */

import { describe, expect, it } from "vitest";
import { DomainError, type EnvFile } from "@mpu/command";
import { runCli } from "../mod.ts";
import { makeFakeIo } from "@mpu/command/testing";

/**
 * Env-файл без ключей: обязательный ключ отказывает классом и текстом
 * настоящего env-файла (`@mpu/command/env`).
 */
function emptyEnv(): EnvFile {
  return {
    get: () => undefined,
    require: (name) => {
      throw new DomainError(
        `environment variable ${name} is not set. ` +
          "Add it to /nowhere/.env or export in shell.",
      );
    },
    set: () => Promise.reject(new Error("запись не ожидалась")),
    values: () => ({}),
  };
}

/** Прогон команды через точку входа: код и stderr. */
async function run(
  argv: readonly string[],
): Promise<{ code: number; stderr: string }> {
  const stderr: string[] = [];
  const code = await runCli(argv, makeFakeIo({ envFile: emptyEnv() }), {
    stdout: () => {},
    stderr: (text) => void stderr.push(text),
  });
  return { code, stderr: stderr.join("") };
}

describe("нет ключа конфигурации — код 1 строкой слоя у каждой команды", () => {
  const cases: readonly (readonly [string, readonly string[], string])[] = [
    ["send", ["telegram", "send", "--chat", "me", "проба"], "TELEGRAM_API_ID"],
    ["ls", ["telegram", "ls"], "TELEGRAM_API_ID"],
    ["search", ["telegram", "search", "проба"], "TELEGRAM_API_ID"],
    [
      "file",
      ["telegram", "file", "--chat", "me", "--id", "1"],
      "TELEGRAM_API_ID",
    ],
    [
      "status",
      ["telegram", "status", "--no-live", "--chat", "me"],
      "TELEGRAM_API_ID",
    ],
    ["log", ["telegram", "log", "проба"], "TELEGRAM_BOT_TOKEN"],
  ];
  for (const [name, argv, key] of cases) {
    it(name, async () => {
      const { code, stderr } = await run(argv);
      expect(stderr).toBe(
        `telegram: environment variable ${key} is not set. ` +
          "Add it to /nowhere/.env or export in shell.\n",
      );
      expect(code, stderr).toBe(1);
    });
  }
});

it("log: отказ Bot API — код 1 строкой слоя", async () => {
  // Прокси — закрытый порт петли: транспорт отказывает сразу, наружу
  // запрос не уходит.
  const values: Readonly<Record<string, string>> = {
    TELEGRAM_BOT_TOKEN: "123:секрет",
    TELEGRAM_BOT_ID: "42",
    TELEGRAM_PROXY: "http://127.0.0.1:1",
  };
  const envFile: EnvFile = {
    ...emptyEnv(),
    get: (name) => values[name],
    require: (name) => values[name] ?? "",
  };
  const stderr: string[] = [];
  const code = await runCli(
    ["telegram", "log", "проба"],
    makeFakeIo({ envFile }),
    { stdout: () => {}, stderr: (text) => void stderr.push(text) },
  );
  const text = stderr.join("");
  expect(text.startsWith("telegram: bot API недоступен: "), text).toBe(true);
  expect(text.includes("секрет"), "токен в тексте отказа").toBe(false);
  expect(code, text).toBe(1);
});
