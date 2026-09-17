import { assertEquals, assertThrows } from "@std/assert";
import { UsageError, VerbatimUsageError } from "../command/mod.ts";
import { searchPlan } from "./search_plan.ts";

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/telegram-search/${name}`, import.meta.url),
  );
}

const ARGS = { query: "", chat: "", from: "", limit: "50" };

Deno.test("разбор аргументов поиска", async (t) => {
  await t.step("глобальный поиск по тексту", () => {
    assertEquals(searchPlan({ ...ARGS, query: "выгрузка" }), {
      query: "выгрузка",
      chat: null,
      from: null,
      limit: 50,
    });
  });
  await t.step("история чата: пустой запрос допустим с --chat", () => {
    assertEquals(searchPlan({ ...ARGS, chat: "me", limit: "20" }), {
      query: "",
      chat: { target: "me", peer: { kind: "me" } },
      from: null,
      limit: 20,
    });
  });
  await t.step("оба адресата приводятся общим резолвом", () => {
    assertEquals(searchPlan({ ...ARGS, chat: "Команда", from: "@ivan" }), {
      query: "",
      chat: { target: "Команда", peer: { kind: "title", title: "Команда" } },
      from: { target: "@ivan", peer: { kind: "name", name: "ivan" } },
      limit: 50,
    });
  });
  await t.step("запрос из одних пробелов — непустой запрос", () => {
    assertEquals(searchPlan({ ...ARGS, query: " " }).query, " ");
  });
});

Deno.test("пустой глобальный поиск запрещён", async () => {
  const err = assertThrows(() => searchPlan(ARGS), VerbatimUsageError);
  assertEquals(
    `${err.message}\n`,
    await golden("err-empty-query-stderr.txt"),
  );
});

Deno.test("--from без --chat требует текст запроса", async () => {
  const err = assertThrows(
    () => searchPlan({ ...ARGS, from: "@ivan" }),
    VerbatimUsageError,
  );
  assertEquals(
    `${err.message}\n`,
    await golden("err-from-without-chat-stderr.txt"),
  );
});

Deno.test("--limit вне диапазона отбивается до сети", async (t) => {
  for (const value of ["0", "501", "-1", "много", "1.5"]) {
    await t.step(value, () => {
      const err = assertThrows(
        () => searchPlan({ ...ARGS, query: "выгрузка", limit: value }),
        UsageError,
      );
      assertEquals(err.message, `--limit вне диапазона 1..500: ${value}`);
    });
  }
});

Deno.test("границы диапазона --limit включительны", async (t) => {
  for (const value of ["1", "500"]) {
    await t.step(value, () => {
      assertEquals(
        searchPlan({ ...ARGS, query: "выгрузка", limit: value }).limit,
        Number(value),
      );
    });
  }
});
