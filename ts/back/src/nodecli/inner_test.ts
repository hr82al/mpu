/**
 * Сборка inner-команды (`platform/portainer.md`, «Сборка inner-команды»
 * и «Валидация значений»).
 */

import { assertEquals, assertThrows } from "@std/assert";
import { formatCommandError, UsageError } from "../command/mod.ts";
import { type Flag, innerText, innerTokens } from "./inner.ts";

function tokens(flags: readonly Flag[]): readonly string[] {
  return innerTokens({ service: "ssUpdater", method: "update", flags });
}

Deno.test("голова команды: node cli service:<сервис> <метод>", () => {
  assertEquals(tokens([]), ["node", "cli", "service:ssUpdater", "update"]);
});

Deno.test("имя флага приводится к kebab-виду", async (t) => {
  const cases: readonly [string, string][] = [
    ["client_id", "--client-id"],
    ["--client_id", "--client-id"],
    ["--client-id", "--client-id"],
    ["client-id", "--client-id"],
  ];
  for (const [written, canonical] of cases) {
    await t.step(written, () => {
      assertEquals(tokens([{ name: written, value: 7 }])[4], canonical);
    });
  }
});

Deno.test("значение по типу", async (t) => {
  await t.step("строка и целое — флаг и один токен", () => {
    assertEquals(tokens([{ name: "logs", value: "info" }]).slice(4), [
      "--logs",
      "info",
    ]);
    assertEquals(tokens([{ name: "client-id", value: 777 }]).slice(4), [
      "--client-id",
      "777",
    ]);
  });

  await t.step("true — флаг без значения", () => {
    assertEquals(tokens([{ name: "dry", value: true }]).slice(4), ["--dry"]);
  });

  await t.step("список — флаг один, значения подряд", () => {
    // sl-back CLI читает подряд идущие не-флаговые токены массивом
    // (спека семейства, `data-loader`).
    assertEquals(tokens([{ name: "sids", value: ["abc", "def"] }]).slice(4), [
      "--sids",
      "abc",
      "def",
    ]);
  });

  await t.step("пустое, false и пустой список — следа нет", () => {
    for (const value of [undefined, null, false, []] as const) {
      assertEquals(tokens([{ name: "logs", value }]).length, 4, `${value}`);
    }
  });
});

Deno.test("порядок флагов — порядок объявления, не сортировка", () => {
  const flags: readonly Flag[] = [
    { name: "date-to", value: "2026-01-31" },
    { name: "client-id", value: 777 },
    { name: "date-from", value: "2026-01-01" },
  ];
  assertEquals(
    innerText({ service: "s", method: "m", flags }),
    "node cli service:s m --date-to 2026-01-31 --client-id 777" +
      " --date-from 2026-01-01",
  );
});

Deno.test("SafeToken: whitelist символов значения", async (t) => {
  await t.step("допустимые символы проходят", () => {
    const allowed = "AZaz09_./:,@[]-";
    assertEquals(
      tokens([{ name: "x", value: allowed }]).slice(4),
      ["--x", allowed],
    );
  });

  await t.step("небезопасные — отказ эталона канала", () => {
    // Значение подставляется в двойные кавычки внутри одинарных, и
    // whitelist — то, что делает подстановку безопасной без
    // квотирования (спека, «Валидация значений»).
    const err = assertThrows(
      () => tokens([{ name: "spreadsheet_id", value: "a b" }]),
      UsageError,
    );
    assertEquals(
      formatCommandError("ss-update", err),
      "mpu ss-update: value contains shell-unsafe chars for" +
        " --spreadsheet-id: 'a b'",
    );
  });

  await t.step("каждый элемент списка проверяется отдельно", () => {
    assertThrows(
      () => tokens([{ name: "sids", value: ["ok", "не ok"] }]),
      UsageError,
      "shell-unsafe chars for --sids",
    );
  });

  await t.step("прочие опасные символы", () => {
    for (const value of ["a$b", "a'b", 'a"b', "a;b", "a|b", "a(b", "a`b", ""]) {
      assertThrows(
        () => tokens([{ name: "x", value }]),
        UsageError,
        "shell-unsafe chars",
      );
    }
  });
});
