import { assertEquals } from "@std/assert";
import { MtcuteError, tl } from "@mtcute/deno";
import { VerbatimError } from "../command/mod.ts";
import { clientRefusal } from "./client_refusal.ts";
import { CryptoInitError } from "./errors.ts";

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
  await t.step("дефект своего кода — как есть", () => {
    const bug = new TypeError("дефект своего кода");
    assertEquals(clientRefusal(bug), bug);
  });
  await t.step("отказ терминала — как есть", () => {
    const refused = new Error("терминал: не удалось прочитать ответ");
    assertEquals(clientRefusal(refused), refused);
  });
});
