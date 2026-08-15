import { assertEquals, assertThrows } from "@std/assert";
import {
  parseStore,
  serializeStore,
  StoreFormatError,
  withAlias,
  withoutAlias,
} from "./mod.ts";

Deno.test("parseStore: отсутствующее хранилище равно пустому", () => {
  const empty = { values: {}, aliases: {} };
  assertEquals(parseStore(undefined), empty);
  assertEquals(parseStore("{}"), empty);
});

Deno.test("parseStore/serializeStore: значения хранятся буквально", () => {
  const raw = serializeStore({
    values: { "xlsx.default": "007" },
    aliases: { otchet: "~/o.xlsx" },
  });
  const store = parseStore(raw);
  assertEquals(store.values["xlsx.default"], "007");
  assertEquals(store.aliases["otchet"], "~/o.xlsx");
});

Deno.test("serializeStore: детерминирован — ключи отсортированы", () => {
  const a = serializeStore({
    values: {},
    aliases: { b: "2", a: "1" },
  });
  const b = serializeStore({
    values: {},
    aliases: { a: "1", b: "2" },
  });
  assertEquals(a, b);
  assertEquals(a.endsWith("\n"), true, "файл кончается переводом строки");
});

Deno.test("parseStore: битое содержимое — StoreFormatError", async (t) => {
  const cases: readonly (readonly [string, string])[] = [
    ["не JSON", "{oops"],
    ["не объект", `"строка"`],
    ["values не объект", `{"values": 5}`],
    ["алиас не строка", `{"aliases": {"a": 1}}`],
  ];
  for (const [name, raw] of cases) {
    await t.step(name, () => {
      assertThrows(() => parseStore(raw), StoreFormatError);
    });
  }
});

Deno.test("withAlias/withoutAlias: неизменяемость и идемпотентность", () => {
  const base = parseStore(`{"aliases": {"a": "1"}}`);
  const added = withAlias(base, "b", "2");
  assertEquals(base.aliases, { a: "1" }, "исходный store не изменён");
  assertEquals(added.aliases, { a: "1", b: "2" });
  const replaced = withAlias(added, "a", "9");
  assertEquals(replaced.aliases, { a: "9", b: "2" }, "upsert");
  const removed = withoutAlias(added, "a");
  assertEquals(removed.aliases, { b: "2" });
  assertEquals(withoutAlias(removed, "нет такого").aliases, { b: "2" });
});
