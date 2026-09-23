/**
 * Имя вызывающего для памяти результатов (`platform/it.md`): токены —
 * как клиент назвал себя, браузер — хэш сессии из cookie, а не поле кадра.
 */

import { assertEquals } from "@std/assert";
import { AGENT, BROWSER, OWNER, SESSION_COOKIE } from "./caller.ts";
import { sessionHash } from "./web.ts";

const URL_ = "http://127.0.0.1/line";

Deno.test("имя вызывающего: токен — из кадра, браузер — хэш сессии", async () => {
  const plain = new Request(URL_);
  assertEquals(await OWNER.naming(plain).of("ppid:7"), "ppid:7");
  assertEquals(await AGENT.naming(plain).of("mcp:s1"), "mcp:s1");
  assertEquals(await OWNER.naming(plain).of(undefined), undefined);
  const cookie = new Request(URL_, {
    headers: { Cookie: `${SESSION_COOKIE}=abc` },
  });
  // Поле кадра браузера не читается: чужая вкладка подставила бы чужое.
  assertEquals(
    await BROWSER.naming(cookie).of("ppid:7"),
    `web:${await sessionHash("abc")}`,
  );
  assertEquals(await BROWSER.naming(plain).of("ppid:7"), undefined);
});
