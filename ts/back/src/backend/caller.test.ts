/**
 * Имя вызывающего для памяти результатов (`platform/it.md`): токены —
 * как клиент назвал себя, браузер — хэш сессии из cookie, а не поле кадра.
 */

import { expect, it } from "vitest";
import { AGENT, BROWSER, OWNER, SESSION_COOKIE } from "./caller.ts";
import { sessionHash } from "./web.ts";

const URL_ = "http://127.0.0.1/line";

it("имя вызывающего: токен — из кадра, браузер — хэш сессии", async () => {
  const plain = new Request(URL_);
  expect(await OWNER.naming(plain).of("ppid:7")).toBe("ppid:7");
  expect(await AGENT.naming(plain).of("mcp:s1")).toBe("mcp:s1");
  expect(await OWNER.naming(plain).of(undefined)).toStrictEqual(undefined);
  const cookie = new Request(URL_, {
    headers: { Cookie: `${SESSION_COOKIE}=abc` },
  });
  // Поле кадра браузера не читается: чужая вкладка подставила бы чужое.
  expect(await BROWSER.naming(cookie).of("ppid:7")).toStrictEqual(
    `web:${await sessionHash("abc")}`,
  );
  expect(await BROWSER.naming(plain).of("ppid:7")).toStrictEqual(undefined);
});
