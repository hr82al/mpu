/**
 * Справка `mpu telegram login` (`docs/specs/telegram-login.md`,
 * инвариант 3). Исход входа через точку входа — пропуск с причиной и
 * код 0 — проверяет `ts/` (`back/src/entrypoint/telegram/cmd_login.test.ts`):
 * ему нужна точка входа приложения.
 */

import { expect, it } from "vitest";
import { telegramLoginCommand } from "./cmd_login.ts";

it("справка mpu telegram login называет все три кода выхода", () => {
  // Коды — часть контракта (`telegram-login.md`, инвариант 3): абзац
  // держится дословно, иначе справка молча разойдётся с поведением.
  const exit = telegramLoginCommand.help.slice(
    telegramLoginCommand.help.indexOf("Exit:"),
  );
  expect(exit).toBe(
    "Exit: 0 — успех и любой пропуск, в том числе сбой самого входа; 2 —\n" +
      "неверный вызов (лишняя опция); 1 — сбой вне сценария: дефект\n" +
      "программы, отказ терминала, записи env-файла или закрытия клиента.",
  );
});
