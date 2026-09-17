/**
 * Запись токен-кэша (`platform/slback-http.md`, «Креды и токен»): что
 * считается живой записью, а что — её отсутствием.
 */

import { assertEquals } from "@std/assert";
import { cachedToken, TOKEN_TTL_SEC, tokenCacheText } from "./mod.ts";

const LIVE = JSON.stringify({ token: "T", expires_at: 1000 });

Deno.test("живая запись отдаёт токен", () => {
  assertEquals(cachedToken(LIVE, 999), "T");
});

Deno.test("срок годности наступил ровно сейчас — записи нет", () => {
  assertEquals(cachedToken(LIVE, 1000), undefined);
  assertEquals(cachedToken(LIVE, 1001), undefined);
});

Deno.test("порча записи — не ошибка, а отсутствие записи", () => {
  assertEquals(cachedToken(undefined, 0), undefined);
  assertEquals(cachedToken("{", 0), undefined);
  assertEquals(cachedToken("[]", 0), undefined);
  assertEquals(cachedToken('"строка"', 0), undefined);
  assertEquals(
    cachedToken(JSON.stringify({ token: 1, expires_at: 9 }), 0),
    undefined,
  );
  assertEquals(
    cachedToken(JSON.stringify({ token: "T", expires_at: "9" }), 0),
    undefined,
  );
});

Deno.test("новая запись живёт ровно TTL от момента получения", () => {
  const text = tokenCacheText("T", 100);
  assertEquals(JSON.parse(text), {
    token: "T",
    expires_at: 100 + TOKEN_TTL_SEC,
  });
  assertEquals(cachedToken(text, 100 + TOKEN_TTL_SEC - 1), "T");
  assertEquals(cachedToken(text, 100 + TOKEN_TTL_SEC), undefined);
});
