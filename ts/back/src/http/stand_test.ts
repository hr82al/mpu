/**
 * Классификация хоста как адреса сети стенда
 * (`docs/specs/platform/loki-http.md`, «Прокси окружения»): четыре
 * диапазона IPv4-литералов, их граничные адреса и всё, что мимо
 * прокси не идёт, — доменные имена, публичные адреса, IPv6.
 */

import { assertEquals } from "@std/assert";
import { isStandHost } from "./stand.ts";

const cases: ReadonlyArray<readonly [string, boolean]> = [
  ["10.0.0.0", true],
  ["10.255.255.255", true],
  ["9.255.255.255", false],
  ["11.0.0.0", false],
  ["172.16.0.0", true],
  ["172.31.255.255", true],
  ["172.15.255.255", false],
  ["172.32.0.1", false],
  ["192.168.0.0", true],
  ["192.168.150.10", true],
  ["192.168.255.255", true],
  ["192.167.255.255", false],
  ["192.169.0.0", false],
  ["127.0.0.0", true],
  ["127.0.0.1", true],
  ["127.255.255.255", true],
  ["126.255.255.255", false],
  ["128.0.0.0", false],
  ["8.8.8.8", false],
  ["localhost", false],
  ["loki.stand.local", false],
  ["10.0.0.1.example.com", false],
  ["[::1]", false],
  ["[::ffff:10.0.0.1]", false],
  ["300.0.0.1", false],
  ["10.0.0.256", false],
  ["", false],
];

Deno.test("адрес сети стенда — IPv4-литерал из четырёх диапазонов", async (t) => {
  for (const [host, expected] of cases) {
    await t.step(host === "" ? "(пусто)" : host, () => {
      assertEquals(isStandHost(host), expected, `хост ${host}`);
    });
  }
});

Deno.test("хост берётся из URL в нормализованной форме", () => {
  // `URL` приводит запись адреса к десятичной с точками: классификация
  // обязана видеть и такие адреса, а не только буквальную запись.
  assertEquals(isStandHost(new URL("http://0x7f.1:3100/").hostname), true);
  assertEquals(isStandHost(new URL("http://[::1]:3100/").hostname), false);
});
