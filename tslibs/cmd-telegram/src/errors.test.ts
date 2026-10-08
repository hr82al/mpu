/**
 * Отказы `@mpu/telegram` у слоя команд (`docs/specs/platform/
 * telegram-mtproto.md`, «Ошибки и коды выхода»): отказ слоя уходит классом
 * контракта команды, ошибка ввода — классом ввода, дефект — тем же
 * объектом. Коды и строки через точку входа проверяет `ts/`
 * (`back/src/entrypoint/telegram/errors.test.ts`).
 */

import { TelegramError, TelegramInputError } from "@mpu/telegram";
import { describe, expect, it } from "vitest";
import { VerbatimError, VerbatimUsageError } from "@mpu/command";
import { commandError } from "./errors.ts";

describe("отказ библиотеки — классом контракта команды", () => {
  it("отказ слоя — VerbatimError с тем же текстом", () => {
    const refusal = new TelegramError("telegram: RPC error: CHAT_INVALID");
    const err = commandError(refusal);
    expect(err instanceof VerbatimError, String(err)).toBe(true);
    expect((err as VerbatimError).message).toBe(refusal.message);
    expect((err as VerbatimError).cause).toBe(refusal);
  });
  it("ошибка ввода — VerbatimUsageError с тем же текстом", () => {
    const refusal = new TelegramInputError("telegram: пустой адресат");
    const err = commandError(refusal);
    expect(err instanceof VerbatimUsageError, String(err)).toBe(true);
    expect((err as VerbatimUsageError).message).toBe(refusal.message);
  });
  it("дефект — тот же объект", () => {
    const defect = new TypeError("дефект");
    expect(commandError(defect)).toBe(defect);
  });
});
