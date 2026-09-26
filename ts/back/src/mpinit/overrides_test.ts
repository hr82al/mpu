/**
 * Разбор override-файлов local-stack — на живых файлах, снятых хостом
 * (`fixtures/mp-init/overrides/`): комментарии внутри блока `services`
 * там есть, и разбор обязан их пропускать.
 */

import { assertEquals } from "@std/assert";
import { composeServicesOf, servicesOf, strangersOf } from "./overrides.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/mp-init/overrides/${name}`, import.meta.url),
  );
}

Deno.test("servicesOf: сервисы живых override-файлов", async (t) => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["sl-base.observability-off.yaml", ["cli", "migrations", "backups"]],
    ["sl-main.observability-off.yaml", [
      "internal-api",
      "api",
      "ss-jobs",
      "currencies-rates-parser",
    ]],
    ["sl-instance.observability-off.yaml", [
      "i-clients-migrations",
      "i-internal-api",
      "currency-rates-sync",
      "support-jobs",
      "data-processor",
      "ss-loader",
      "ss-updater",
      "wb-loader",
      "ozon-loader",
      "i-wb-unit-calc-worker",
    ]],
  ];
  for (const [name, services] of cases) {
    await t.step(name, () => assertEquals(servicesOf(fixture(name)), services));
  }
});

Deno.test("servicesOf: ключи вне блока services не сервисы", () => {
  const text = [
    "volumes:",
    "  data:",
    "services:",
    "  # закомментированный:",
    "",
    "  api:",
    "    environment:",
    "      X: 1",
    "networks:",
    "  default:",
  ].join("\n");
  assertEquals(servicesOf(text), ["api"]);
});

Deno.test("strangersOf: только сервисы без пары в compose", () => {
  const compose = composeServicesOf("api\ncli\n\n");
  assertEquals(compose, ["api", "cli"]);
  assertEquals(strangersOf(["api", "m-nats-listeners"], compose), [
    "m-nats-listeners",
  ]);
  assertEquals(strangersOf(["cli"], compose), []);
});
