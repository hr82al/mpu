/**
 * Запись токен-кэша (`platform/slback-http.md`, «Креды и токен»): что
 * считается живой записью, а что — её отсутствием.
 */

import { expect, it } from "vitest";
import { cachedToken, TOKEN_TTL_SEC, tokenCacheText } from "./mod.ts";

const LIVE = JSON.stringify({ token: "T", expires_at: 1000 });

it("живая запись отдаёт токен", () => {
  expect(cachedToken(LIVE, 999)).toBe("T");
});

it("срок годности наступил ровно сейчас — записи нет", () => {
  expect(cachedToken(LIVE, 1000)).toStrictEqual(undefined);
  expect(cachedToken(LIVE, 1001)).toStrictEqual(undefined);
});

it("порча записи — не ошибка, а отсутствие записи", () => {
  expect(cachedToken(undefined, 0)).toStrictEqual(undefined);
  expect(cachedToken("{", 0)).toStrictEqual(undefined);
  expect(cachedToken("[]", 0)).toStrictEqual(undefined);
  expect(cachedToken('"строка"', 0)).toStrictEqual(undefined);
  expect(cachedToken(JSON.stringify({ token: 1, expires_at: 9 }), 0))
    .toStrictEqual(undefined);
  expect(cachedToken(JSON.stringify({ token: "T", expires_at: "9" }), 0))
    .toStrictEqual(undefined);
});

it("новая запись живёт ровно TTL от момента получения", () => {
  const text = tokenCacheText("T", 100);
  expect(JSON.parse(text)).toStrictEqual({
    token: "T",
    expires_at: 100 + TOKEN_TTL_SEC,
  });
  expect(cachedToken(text, 100 + TOKEN_TTL_SEC - 1)).toBe("T");
  expect(cachedToken(text, 100 + TOKEN_TTL_SEC)).toStrictEqual(undefined);
});
