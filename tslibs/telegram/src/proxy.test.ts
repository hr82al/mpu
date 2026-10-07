import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import { parseProxy, type ProxySettings, proxyUrl } from "./proxy.ts";
import { TelegramError } from "./errors.ts";

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

describe("разбор прокси-URL", () => {
  for (const { input, settings } of CASES) {
    it(input, () => expect(parseProxy(input)).toStrictEqual(settings));
  }
});

it("прокси-URL без порта отвергается", () => {
  const err = thrown(() => {
    parseProxy("socks5://10.0.0.1");
  }, TelegramError);
  expect(err.message).toBe(
    "telegram: в прокси-URL нужен host:port — 'socks5://10.0.0.1'",
  );
});

it("прокси-URL без схемы отвергается", () => {
  const err = thrown(() => {
    parseProxy("10.0.0.1:1080");
  }, TelegramError);
  expect(err.message).toBe(
    "telegram: в прокси-URL нужен host:port — '10.0.0.1:1080'",
  );
});

it("неподдерживаемая схема прокси", () => {
  const err = thrown(() => {
    parseProxy("ftp://10.0.0.1:21");
  }, TelegramError);
  expect(err.message).toStrictEqual(
    "telegram: неподдерживаемая схема прокси 'ftp'; " +
      "попробуй: http/https/socks5/socks4",
  );
});

describe("учётные данные не попадают в текст ошибки", () => {
  for (const input of [
    "ftp://user:s3cret@10.0.0.1:21",
    // Пароль с литеральным «@»: ради него и делается percent-декод.
    "socks5://user:pa%40s3cret@10.0.0.1",
    "socks5://user:pa@s3cret@10.0.0.1",
    // Формы, на которых разбор URL не удаётся вовсе.
    "socks5:/user:s3cret@10.0.0.1:1080",
    " socks5://user:s3cret@10.0.0.1",
  ]) {
    it(input, () => {
      const err = thrown(() => {
        parseProxy(input);
      }, TelegramError);
      expect(err.message.includes("s3cret"), err.message).toBe(false);
      expect(err.message.includes("user"), err.message).toBe(false);
    });
  }
});

describe("URL для транспорта собирается обратно", () => {
  it("без учётных данных", () => {
    expect(proxyUrl({ tunnel: "socks5", host: "10.0.0.1", port: 1080 })).toBe(
      "socks5://10.0.0.1:1080",
    );
  });
  it("с учётными данными", () => {
    expect(
      proxyUrl({
        tunnel: "socks5",
        host: "10.0.0.1",
        port: 1080,
        username: "us@er",
        password: "p:ss",
      }),
    ).toBe("socks5://us%40er:p%3Ass@10.0.0.1:1080");
  });
});
