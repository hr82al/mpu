import { assertEquals, assertThrows } from "@std/assert";
import { parseProxy, type ProxySettings, proxyUrl } from "./proxy.ts";
import { VerbatimError } from "../command/mod.ts";

const CASES: readonly {
  readonly input: string;
  readonly settings: ProxySettings;
}[] = [
  {
    input: "socks5://10.0.0.1:1080",
    settings: { tunnel: "socks5", host: "10.0.0.1", port: 1080 },
  },
  // Схемы с «h»/«a» — синонимы основных: резолв имён на стороне прокси
  // ничего не меняет, адреса узлов Telegram приходят числовыми.
  {
    input: "socks5h://10.0.0.1:1080",
    settings: { tunnel: "socks5", host: "10.0.0.1", port: 1080 },
  },
  {
    input: "socks4a://10.0.0.1:1080",
    settings: { tunnel: "socks4", host: "10.0.0.1", port: 1080 },
  },
  {
    input: "http://proxy.example:3128",
    settings: { tunnel: "http", host: "proxy.example", port: 3128 },
  },
  {
    input: "https://proxy.example:3128",
    settings: { tunnel: "https", host: "proxy.example", port: 3128 },
  },
  {
    input: "socks5://user:pass@10.0.0.1:1080",
    settings: {
      tunnel: "socks5",
      host: "10.0.0.1",
      port: 1080,
      username: "user",
      password: "pass",
    },
  },
  {
    input: "socks5://us%40er:p%3Ass@10.0.0.1:1080",
    settings: {
      tunnel: "socks5",
      host: "10.0.0.1",
      port: 1080,
      username: "us@er",
      password: "p:ss",
    },
  },
];

Deno.test("разбор прокси-URL", async (t) => {
  for (const { input, settings } of CASES) {
    await t.step(input, () => assertEquals(parseProxy(input), settings));
  }
});

Deno.test("прокси-URL без порта отвергается", () => {
  const err = assertThrows(
    () => parseProxy("socks5://10.0.0.1"),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: в прокси-URL нужен host:port — 'socks5://10.0.0.1'",
  );
});

Deno.test("прокси-URL без схемы отвергается", () => {
  const err = assertThrows(() => parseProxy("10.0.0.1:1080"), VerbatimError);
  assertEquals(
    err.message,
    "telegram: в прокси-URL нужен host:port — '10.0.0.1:1080'",
  );
});

Deno.test("неподдерживаемая схема прокси", () => {
  const err = assertThrows(
    () => parseProxy("ftp://10.0.0.1:21"),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: неподдерживаемая схема прокси 'ftp'; " +
      "попробуй: http/https/socks5/socks4",
  );
});

Deno.test("учётные данные не попадают в текст ошибки", async (t) => {
  for (
    const input of [
      "ftp://user:s3cret@10.0.0.1:21",
      // Пароль с литеральным «@»: ради него и делается percent-декод.
      "socks5://user:pa%40s3cret@10.0.0.1",
      "socks5://user:pa@s3cret@10.0.0.1",
      // Формы, на которых разбор URL не удаётся вовсе.
      "socks5:/user:s3cret@10.0.0.1:1080",
      " socks5://user:s3cret@10.0.0.1",
    ]
  ) {
    await t.step(input, () => {
      const err = assertThrows(() => parseProxy(input), VerbatimError);
      assertEquals(err.message.includes("s3cret"), false, err.message);
      assertEquals(err.message.includes("user"), false, err.message);
    });
  }
});

Deno.test("URL для транспорта собирается обратно", async (t) => {
  await t.step("без учётных данных", () => {
    assertEquals(
      proxyUrl({ tunnel: "socks5", host: "10.0.0.1", port: 1080 }),
      "socks5://10.0.0.1:1080",
    );
  });
  await t.step("с учётными данными", () => {
    assertEquals(
      proxyUrl({
        tunnel: "socks5",
        host: "10.0.0.1",
        port: 1080,
        username: "us@er",
        password: "p:ss",
      }),
      "socks5://us%40er:p%3Ass@10.0.0.1:1080",
    );
  });
});
