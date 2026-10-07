import { readFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
import { UsageError, VerbatimUsageError } from "../command/mod.ts";
import { searchPlan } from "./search_plan.ts";

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`./testdata/telegram-search/${name}`, import.meta.url),
    "utf8",
  );
}

const ARGS = { query: "", chat: "", from: "", limit: "50" };

describe("разбор аргументов поиска", () => {
  it("глобальный поиск по тексту", () => {
    expect(searchPlan({ ...ARGS, query: "выгрузка" })).toStrictEqual({
      query: "выгрузка",
      chat: null,
      from: null,
      limit: 50,
    });
  });
  it("история чата: пустой запрос допустим с --chat", () => {
    expect(searchPlan({ ...ARGS, chat: "me", limit: "20" })).toStrictEqual({
      query: "",
      chat: { target: "me", peer: { kind: "me" } },
      from: null,
      limit: 20,
    });
  });
  it("оба адресата приводятся общим резолвом", () => {
    expect(
      searchPlan({ ...ARGS, chat: "Команда", from: "@ivan" }),
    ).toStrictEqual({
      query: "",
      chat: { target: "Команда", peer: { kind: "title", title: "Команда" } },
      from: { target: "@ivan", peer: { kind: "name", name: "ivan" } },
      limit: 50,
    });
  });
  it("запрос из одних пробелов — непустой запрос", () => {
    expect(searchPlan({ ...ARGS, query: " " }).query).toBe(" ");
  });
});

it("пустой глобальный поиск запрещён", async () => {
  let err: unknown;
  try {
    searchPlan(ARGS);
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof VerbatimUsageError,
    "ожидался отказ VerbatimUsageError",
  );
  expect(`${err.message}\n`).toStrictEqual(
    await golden("err-empty-query-stderr.txt"),
  );
});

it("--from без --chat требует текст запроса", async () => {
  let err: unknown;
  try {
    searchPlan({ ...ARGS, from: "@ivan" });
  } catch (e) {
    err = e;
  }
  assert(
    err instanceof VerbatimUsageError,
    "ожидался отказ VerbatimUsageError",
  );
  expect(`${err.message}\n`).toStrictEqual(
    await golden("err-from-without-chat-stderr.txt"),
  );
});

describe("--limit вне диапазона отбивается до сети", () => {
  for (const value of ["0", "501", "-1", "много", "1.5"]) {
    it(value, () => {
      const err = thrown(() => {
        searchPlan({ ...ARGS, query: "выгрузка", limit: value });
      }, UsageError);
      expect(err.message).toStrictEqual(
        `--limit вне диапазона 1..500: ${value}`,
      );
    });
  }
});

describe("границы диапазона --limit включительны", () => {
  for (const value of ["1", "500"]) {
    it(value, () => {
      expect(
        searchPlan({ ...ARGS, query: "выгрузка", limit: value }).limit,
      ).toStrictEqual(Number(value));
    });
  }
});
