import { assertEquals, assertStrictEquals } from "@std/assert";
import { MtcuteError, tl } from "@mtcute/deno";
import { VerbatimError } from "../command/mod.ts";
import { clientRefusal } from "./client_refusal.ts";
import { configError, CryptoInitError, inputError } from "./errors.ts";

Deno.test("отказ клиента: текстом слоя — только отказ библиотеки, прочее как есть", async (t) => {
  // Инвариант 3 (`telegram-login.md`, «Что считается сбоем самого входа»):
  // отказ протокола, библиотеки и криптографии оформляется строкой слоя и
  // становится пропуском; дефект кода и отказ терминала — нет.
  await t.step("отказ протокола — RPC error", () => {
    const err = clientRefusal(new tl.RpcError(400, "PHONE_CODE_INVALID"));
    assertEquals(err instanceof VerbatimError, true, String(err));
    assertEquals(
      err instanceof Error ? err.message : "",
      "telegram: RPC error: PHONE_CODE_INVALID",
    );
  });
  await t.step("отказ библиотеки — строкой слоя", () => {
    const err = clientRefusal(new MtcuteError("Session is reset"));
    assertEquals(err instanceof VerbatimError, true, String(err));
  });
  await t.step("сбой криптографии — текстом спеки", () => {
    const err = clientRefusal(new CryptoInitError("нет встроенного модуля"));
    assertEquals(
      err instanceof Error ? err.message : "",
      "telegram: криптография клиента не поднялась: нет встроенного модуля",
    );
  });
  await t.step("rate-limit — срок из отказа, созданного клиентом", () => {
    // Живой отказ клиент создаёт `fromTl`: он и разбирает срок в `seconds`.
    const err = clientRefusal(
      tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_7" }),
    );
    assertEquals(
      err instanceof Error ? err.message : "",
      "telegram: rate-limit, подожди 7s",
    );
  });
  await t.step("текст протокола — из поля отказа, а не из сообщения", () => {
    const original = tl.RpcError.fromTl({
      errorCode: 403,
      errorMessage: "CHAT_WRITE_FORBIDDEN",
    });
    const err = clientRefusal(original);
    assertEquals(
      err instanceof Error ? err.message : "",
      "telegram: RPC error: CHAT_WRITE_FORBIDDEN",
    );
    assertEquals(err instanceof Error ? err.cause : undefined, original);
  });
  await t.step("своё оформление слоя — тем же объектом", () => {
    const own = configError("не удалось найти чат 'X': совпадений нет");
    assertStrictEquals(clientRefusal(own), own);
    // Ошибка ввода не понижается до отказа Telegram: код 2 не станет 1.
    const input = inputError("пустой текст сообщения");
    assertStrictEquals(clientRefusal(input), input);
  });
  await t.step("дефект своего кода — как есть", () => {
    const bug = new TypeError("дефект своего кода");
    assertEquals(clientRefusal(bug), bug);
  });
  await t.step("отказ терминала — как есть", () => {
    const refused = new Error("терминал: не удалось прочитать ответ");
    assertEquals(clientRefusal(refused), refused);
  });
});
