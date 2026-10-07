/**
 * Сборка inner-команды (`platform/portainer.md`, «Сборка inner-команды»
 * и «Валидация значений»).
 */

import { assert, describe, expect, it } from "vitest";
import { formatCommandError, UsageError } from "../command/mod.ts";
import { type Flag, innerText, innerTokens } from "./inner.ts";

function tokens(flags: readonly Flag[]): readonly string[] {
  return innerTokens({ service: "ssUpdater", method: "update", flags });
}

it("голова команды: node cli service:<сервис> <метод>", () => {
  expect(tokens([])).toStrictEqual([
    "node",
    "cli",
    "service:ssUpdater",
    "update",
  ]);
});

describe("имя флага приводится к kebab-виду", () => {
  const cases: readonly [string, string][] = [
    ["client_id", "--client-id"],
    ["--client_id", "--client-id"],
    ["--client-id", "--client-id"],
    ["client-id", "--client-id"],
  ];
  for (const [written, canonical] of cases) {
    it(written, () => {
      expect(tokens([{ name: written, value: 7 }])[4]).toStrictEqual(canonical);
    });
  }
});

describe("значение по типу", () => {
  it("строка и целое — флаг и один токен", () => {
    expect(tokens([{ name: "logs", value: "info" }]).slice(4)).toStrictEqual([
      "--logs",
      "info",
    ]);
    expect(tokens([{ name: "client-id", value: 777 }]).slice(4)).toStrictEqual([
      "--client-id",
      "777",
    ]);
  });

  it("true — флаг без значения", () => {
    expect(tokens([{ name: "dry", value: true }]).slice(4)).toStrictEqual([
      "--dry",
    ]);
  });

  it("список — флаг один, значения подряд", () => {
    // sl-back CLI читает подряд идущие не-флаговые токены массивом
    // (спека семейства, `data-loader`).
    expect(tokens([{ name: "sids", value: ["abc", "def"] }]).slice(4))
      .toStrictEqual([
        "--sids",
        "abc",
        "def",
      ]);
  });

  it("пустое, false и пустой список — следа нет", () => {
    for (const value of [undefined, null, false, []] as const) {
      expect(tokens([{ name: "logs", value }]).length, `${value}`).toBe(4);
    }
  });
});

it("порядок флагов — порядок объявления, не сортировка", () => {
  const flags: readonly Flag[] = [
    { name: "date-to", value: "2026-01-31" },
    { name: "client-id", value: 777 },
    { name: "date-from", value: "2026-01-01" },
  ];
  expect(innerText({ service: "s", method: "m", flags })).toStrictEqual(
    "node cli service:s m --date-to 2026-01-31 --client-id 777" +
      " --date-from 2026-01-01",
  );
});

describe("SafeToken: whitelist символов значения", () => {
  it("допустимые символы проходят", () => {
    const allowed = "AZaz09_./:,@[]-";
    expect(tokens([{ name: "x", value: allowed }]).slice(4)).toStrictEqual([
      "--x",
      allowed,
    ]);
  });

  it("небезопасные — отказ эталона канала", () => {
    // Значение подставляется в двойные кавычки внутри одинарных, и
    // whitelist — то, что делает подстановку безопасной без
    // квотирования (спека, «Валидация значений»).
    let err: unknown;
    try {
      tokens([{ name: "spreadsheet_id", value: "a b" }]);
    } catch (thrown) {
      err = thrown;
    }
    assert(err instanceof UsageError);
    expect(formatCommandError("ss-update", err)).toStrictEqual(
      "mpu ss-update: value contains shell-unsafe chars for" +
        " --spreadsheet-id: 'a b'",
    );
  });

  it("каждый элемент списка проверяется отдельно", () => {
    expect(() => tokens([{ name: "sids", value: ["ok", "не ok"] }])).toThrow(
      UsageError,
    );
    expect(() => tokens([{ name: "sids", value: ["ok", "не ok"] }])).toThrow(
      "shell-unsafe chars for --sids",
    );
  });

  it("прочие опасные символы", () => {
    for (const value of ["a$b", "a'b", 'a"b', "a;b", "a|b", "a(b", "a`b", ""]) {
      expect(() => tokens([{ name: "x", value }])).toThrow(UsageError);
      expect(() => tokens([{ name: "x", value }])).toThrow(
        "shell-unsafe chars",
      );
    }
  });
});
