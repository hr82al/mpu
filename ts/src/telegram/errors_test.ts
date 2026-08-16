import { assertEquals, assertRejects } from "@std/assert";
import { VerbatimError, VerbatimUsageError } from "../command/mod.ts";
import { configError, inputError, telegramOperation } from "./errors.ts";

Deno.test("успешное обращение отдаёт результат как есть", async () => {
  assertEquals(await telegramOperation(() => Promise.resolve(42)), 42);
});

Deno.test("отказ протокола оформляется строкой слоя", async (t) => {
  await t.step("rate-limit", async () => {
    const flood = Object.assign(new Error("FLOOD_WAIT"), { seconds: 7 });
    const err = await assertRejects(
      () => telegramOperation(() => Promise.reject(flood)),
      VerbatimError,
    );
    assertEquals(err.message, "telegram: rate-limit, подожди 7s");
  });
  await t.step("прочий отказ", async () => {
    const rpc = Object.assign(new Error("RPC_CALL_FAIL"), {
      text: "CHAT_ADMIN_REQUIRED",
    });
    const err = await assertRejects(
      () => telegramOperation(() => Promise.reject(rpc)),
      VerbatimError,
    );
    assertEquals(err.message, "telegram: RPC error: CHAT_ADMIN_REQUIRED");
  });
});

Deno.test("своё оформление слоя не заворачивается второй раз", async (t) => {
  await t.step("доменный отказ", async () => {
    const own = configError("не удалось найти чат 'X': совпадений нет");
    const err = await assertRejects(
      () => telegramOperation(() => Promise.reject(own)),
      VerbatimError,
    );
    assertEquals(err, own);
    assertEquals(err.message.includes("RPC error"), false);
  });
  await t.step("ошибка ввода не понижается до отказа Telegram", async () => {
    // Иначе код выхода 2 стал бы 1: ошибка ввода выдала бы себя за
    // отказ протокола.
    const own = inputError("пустой текст сообщения");
    const err = await assertRejects(
      () => telegramOperation(() => Promise.reject(own)),
      VerbatimUsageError,
    );
    assertEquals(err, own);
  });
});
