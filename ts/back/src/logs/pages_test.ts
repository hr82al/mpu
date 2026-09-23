/**
 * Логи любой длины (`platform/long-output.md`, §2): страницы назад от
 * конца окна, граница страницы с одним временем — без дублей и потерь,
 * остановка. Loki поддельный: окно, направление и свой предел на запрос.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { type LogEntry, LokiHttpError, type RangeQuery } from "../loki/mod.ts";
import { readNewest } from "./pages.ts";

const WINDOW = { logql: '{host="sl-1"}', startNs: 0n, endNs: 1_000_000n };

function entry(ts: number, line: string): LogEntry {
  return { tsNs: String(ts), line, labels: { host: "sl-1" } };
}

/**
 * Поддельный Loki над записями `entries`: окно `[start, end)` (или
 * `[start, end]`), самые новые первыми, не больше `limit` запроса;
 * запрос сверх своего предела — отказ, как у настоящего.
 */
function fakeLoki(
  entries: readonly LogEntry[],
  maxEntries: number,
  endInclusive = false,
) {
  const asked: RangeQuery[] = [];
  const read = (query: RangeQuery): Promise<readonly LogEntry[]> => {
    asked.push(query);
    if (query.limit > maxEntries) {
      return Promise.reject(
        new LokiHttpError(400, "max entries limit per query exceeded"),
      );
    }
    const inside = entries.filter((one) => {
      const ns = BigInt(one.tsNs);
      const beforeEnd = endInclusive ? ns <= query.endNs : ns < query.endNs;
      return ns >= query.startNs && beforeEnd;
    });
    const newestFirst = [...inside].reverse().sort((a, b) =>
      Number(BigInt(b.tsNs) - BigInt(a.tsNs))
    );
    return Promise.resolve(newestFirst.slice(0, query.limit));
  };
  return { asked, read };
}

Deno.test("11000 записей при пределе 5000: всё по возрастанию, 3 запроса", async () => {
  const all = Array.from({ length: 11000 }, (_, i) => entry(i + 1, `s${i}`));
  const loki = fakeLoki(all, 5000);
  const got = await readNewest(loki.read, WINDOW, 12000, 5000);
  assertEquals(got.length, 11000);
  assertEquals(got, all);
  assertEquals(loki.asked.length, 3);
  assertEquals(loki.asked.map((query) => query.direction), [
    "backward",
    "backward",
    "backward",
  ]);
});

Deno.test("limit в пределах страницы — один запрос, как прежде", async () => {
  const all = Array.from({ length: 300 }, (_, i) => entry(i + 1, `s${i}`));
  const loki = fakeLoki(all, 5000);
  const got = await readNewest(loki.read, WINDOW, 200, 5000);
  assertEquals(got, all.slice(-200));
  assertEquals(loki.asked, [{ ...WINDOW, limit: 200, direction: "backward" }]);
});

Deno.test("граница страниц с одним временем — без дублей и потерь", async (t) => {
  // Группы одного времени режутся пределом страницы посередине.
  const all = [
    entry(1, "a"),
    entry(2, "b"),
    entry(3, "c1"),
    entry(3, "c2"),
    entry(3, "c3"),
    entry(4, "d"),
    entry(5, "e1"),
    entry(5, "e2"),
    entry(6, "f"),
    entry(7, "g1"),
    entry(7, "g2"),
    entry(7, "g3"),
  ];
  for (const endInclusive of [false, true]) {
    await t.step(
      endInclusive ? "конец окна включён" : "конец окна исключён",
      async () => {
        const loki = fakeLoki(all, 5, endInclusive);
        const got = await readNewest(loki.read, WINDOW, 100, 5);
        assertEquals(
          [...got].map((one) => `${one.tsNs}:${one.line}`).sort(),
          all.map((one) => `${one.tsNs}:${one.line}`).sort(),
        );
        assertEquals(got.map((one) => one.tsNs), all.map((one) => one.tsNs));
      },
    );
  }
});

Deno.test("одинаковые записи внутри страницы — все, как у разового запроса", async () => {
  const all = [entry(1, "a"), entry(2, "двойная"), entry(2, "двойная")];
  const loki = fakeLoki(all, 5000);
  const got = await readNewest(loki.read, WINDOW, 200, 5000);
  assertEquals(got, all);
});

Deno.test("та же строка в другом потоке — другая запись", async () => {
  const other = { ...entry(2, "x"), labels: { host: "sl-2" } };
  const all = [entry(1, "a"), entry(2, "x"), other, entry(3, "c")];
  const loki = fakeLoki(all, 3);
  const got = await readNewest(loki.read, WINDOW, 100, 3);
  assertEquals(got.length, 4);
});

Deno.test("страница из одного времени целиком — остановка, не цикл", async () => {
  const all = Array.from({ length: 6 }, (_, i) => entry(9, `same${i}`));
  const loki = fakeLoki(all, 5);
  const got = await readNewest(loki.read, WINDOW, 100, 5);
  // Шестую запись того же времени страницами не достать: следующая
  // страница повторяет первую, и новых записей в ней нет.
  assertEquals(got.length, 5);
  assertEquals(loki.asked.length, 2);
});

Deno.test("набрано limit — дальше не спрашивать, берутся последние", async () => {
  const all = Array.from({ length: 30 }, (_, i) => entry(i + 1, `s${i}`));
  const loki = fakeLoki(all, 10);
  const got = await readNewest(loki.read, WINDOW, 25, 10);
  assertEquals(got, all.slice(-25));
  assertEquals(loki.asked.map((query) => query.limit), [10, 10, 10]);
});

Deno.test("пустое окно — один запрос, пусто", async () => {
  const loki = fakeLoki([], 5000);
  assertEquals(await readNewest(loki.read, WINDOW, 12000, 5000), []);
  assertEquals(loki.asked.length, 1);
});

Deno.test("ошибка второй страницы — ошибка всего чтения", async () => {
  const all = Array.from({ length: 20 }, (_, i) => entry(i + 1, `s${i}`));
  const inner = fakeLoki(all, 10);
  let call = 0;
  const read = (query: RangeQuery) =>
    ++call === 2
      ? Promise.reject(new LokiHttpError(500, "boom"))
      : inner.read(query);
  await assertRejects(() => readNewest(read, WINDOW, 100, 10), LokiHttpError);
});
