/**
 * Разбор override-файлов local-stack — на живых файлах, снятых хостом
 * (`fixtures/mp-init/overrides/`): комментарии внутри блока `services`
 * там есть, и разбор обязан их пропускать.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { composeServicesOf, servicesOf, strangersOf } from "./overrides.ts";

function fixture(name: string): string {
  return readFileSync(
    new URL(`./testdata/mp-init/overrides/${name}`, import.meta.url),
    "utf8",
  );
}

describe("servicesOf: сервисы живых override-файлов", () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["sl-base.observability-off.yaml", ["cli", "migrations", "backups"]],
    [
      "sl-main.observability-off.yaml",
      ["internal-api", "api", "ss-jobs", "currencies-rates-parser"],
    ],
    [
      "sl-instance.observability-off.yaml",
      [
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
      ],
    ],
  ];
  for (const [name, services] of cases) {
    it(name, () => expect(servicesOf(fixture(name))).toStrictEqual(services));
  }
});

it("servicesOf: ключи вне блока services не сервисы", () => {
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
  expect(servicesOf(text)).toStrictEqual(["api"]);
});

it("strangersOf: только сервисы без пары в compose", () => {
  const compose = composeServicesOf("api\ncli\n\n");
  expect(compose).toStrictEqual(["api", "cli"]);
  expect(strangersOf(["api", "m-nats-listeners"], compose)).toStrictEqual([
    "m-nats-listeners",
  ]);
  expect(strangersOf(["cli"], compose)).toStrictEqual([]);
});
