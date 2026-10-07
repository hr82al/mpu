import { describe, expect, it } from "vitest";
import { MtcuteError, tl } from "@mtcute/node";
import {
  configError,
  CryptoInitError,
  inputError,
  TelegramError,
} from "./errors.ts";
import { clientRefusal } from "./client_refusal.ts";

describe("отказ клиента: текстом слоя — только отказ библиотеки, прочее как есть", () => {
  // Инвариант 3 (`telegram-login.md`, «Что считается сбоем самого входа»):
  // отказ протокола, библиотеки и криптографии оформляется строкой слоя и
  // становится пропуском; дефект кода и отказ терминала — нет.
  it("отказ протокола — RPC error", () => {
    const err = clientRefusal(new tl.RpcError(400, "PHONE_CODE_INVALID"));
    expect(err instanceof TelegramError, String(err)).toStrictEqual(true);
    expect(err instanceof Error ? err.message : "").toStrictEqual(
      "telegram: RPC error: PHONE_CODE_INVALID",
    );
  });
  it("отказ библиотеки — строкой слоя", () => {
    const err = clientRefusal(new MtcuteError("Session is reset"));
    expect(err instanceof TelegramError, String(err)).toStrictEqual(true);
  });
  it("сбой криптографии — текстом спеки", () => {
    const err = clientRefusal(new CryptoInitError("нет встроенного модуля"));
    expect(err instanceof Error ? err.message : "").toStrictEqual(
      "telegram: криптография клиента не поднялась: нет встроенного модуля",
    );
  });
  it("rate-limit — срок из отказа, созданного клиентом", () => {
    // Живой отказ клиент создаёт `fromTl`: он и разбирает срок в `seconds`.
    const err = clientRefusal(
      tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_7" }),
    );
    expect(err instanceof Error ? err.message : "").toStrictEqual(
      "telegram: rate-limit, подожди 7s",
    );
  });
  it("текст протокола — из поля отказа, а не из сообщения", () => {
    const original = tl.RpcError.fromTl({
      errorCode: 403,
      errorMessage: "CHAT_WRITE_FORBIDDEN",
    });
    const err = clientRefusal(original);
    expect(err instanceof Error ? err.message : "").toStrictEqual(
      "telegram: RPC error: CHAT_WRITE_FORBIDDEN",
    );
    expect(err instanceof Error ? err.cause : undefined).toStrictEqual(
      original,
    );
  });
  it("своё оформление слоя — тем же объектом", () => {
    const own = configError("не удалось найти чат 'X': совпадений нет");
    expect(clientRefusal(own)).toBe(own);
    // Ошибка ввода не понижается до отказа Telegram: код 2 не станет 1.
    const input = inputError("пустой текст сообщения");
    expect(clientRefusal(input)).toBe(input);
  });
  it("дефект своего кода — как есть", () => {
    const bug = new TypeError("дефект своего кода");
    expect(clientRefusal(bug)).toStrictEqual(bug);
  });
  it("отказ терминала — как есть", () => {
    const refused = new Error("терминал: не удалось прочитать ответ");
    expect(clientRefusal(refused)).toStrictEqual(refused);
  });
});
