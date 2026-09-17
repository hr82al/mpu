/**
 * Разбор `--since`, границы окна и сборка LogQL (`docs/specs/logs.md`,
 * «CLI-контракт»). Всё чисто: ни сети, ни настоящих часов — момент
 * отсчёта передаётся параметром.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import {
  buildLogQl,
  parseSince,
  toNanoseconds,
  windowStartMs,
} from "./query.ts";

/** Умолчания частей: тест называет только то, что проверяет. */
function parts(overrides: Partial<Parameters<typeof buildLogQl>[0]> = {}) {
  return {
    noStdout: false,
    noStderr: false,
    greps: [],
    regexes: [],
    ...overrides,
  };
}

Deno.test("--since: unix-ts, относительные единицы и отказ", async (t) => {
  await t.step("одни цифры — абсолютный ts, а не «столько назад»", () => {
    assertEquals(parseSince("60"), { kind: "absolute", unixSeconds: 60 });
    assertEquals(windowStartMs(parseSince("60"), 5_000_000, 0), 60_000);
  });

  await t.step("число с единицей — сдвиг назад от now", () => {
    const cases: readonly (readonly [string, number])[] = [
      ["30s", 30_000],
      ["10m", 600_000],
      ["1h", 3_600_000],
      ["2d", 172_800_000],
    ];
    for (const [raw, ms] of cases) {
      assertEquals(parseSince(raw), { kind: "relative", ms }, raw);
      assertEquals(
        windowStartMs(parseSince(raw), 1_000_000_000, 0),
        1_000_000_000 - ms,
      );
    }
  });

  await t.step("прочее — ошибка ввода с текстом спеки", () => {
    const err = assertThrows(() => parseSince("5x"), UsageError);
    assertEquals(
      err.message,
      "--since: ожидается <число>{s|m|h|d} или unix-ts, получено '5x'",
    );
    assertThrows(() => parseSince(""), UsageError);
    assertThrows(() => parseSince("-1h"), UsageError);
  });

  await t.step("без --since окно — умолчание вызова", () => {
    assertEquals(windowStartMs(undefined, 1_000_000, 300_000), 700_000);
  });
});

Deno.test("наносекунды считаются без потери разрядов", () => {
  // 1.7e18 не влезает в number: перевод обязан идти в BigInt.
  assertEquals(toNanoseconds(1_754_380_800_123), 1_754_380_800_123_000_000n);
});

Deno.test("LogQL: порядок частей и экранирование", async (t) => {
  await t.step("без хоста — матчер всех хостов", () => {
    assertEquals(buildLogQl(parts()), '{host=~".+"}');
  });

  await t.step("хост, сервис и потоки — один label-блок через запятую", () => {
    assertEquals(
      buildLogQl(parts({
        host: "sl-1",
        service: "wb-loader",
        noStdout: true,
        noStderr: true,
      })),
      '{host="sl-1",compose_service="wb-loader",stream!="stdout",' +
        'stream!="stderr"}',
    );
  });

  await t.step(
    "фильтры: greps, regexes, client, level — в этом порядке",
    () => {
      assertEquals(
        buildLogQl(parts({
          host: "sl-1",
          greps: ["первый", "второй"],
          regexes: ["ERR.*"],
          client: 4326,
          level: "ERROR",
        })),
        '{host="sl-1"} |= `первый` |= `второй` |~ `ERR.*` |= `4326`' +
          ' | detected_level="error"',
      );
    },
  );

  await t.step("label-значение экранирует обратный слэш и кавычку", () => {
    assertEquals(
      buildLogQl(parts({ host: 'sl\\-"1"' })),
      '{host="sl\\\\-\\"1\\""}',
    );
  });

  await t.step("line-фильтр с backtick уходит в двойные кавычки", () => {
    assertEquals(
      buildLogQl(parts({ greps: ["a`b", 'c"d'] })),
      '{host=~".+"} |= "a`b" |= `c"d`',
    );
  });
});
