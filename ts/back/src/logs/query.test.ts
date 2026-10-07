/**
 * Разбор `--since`, границы окна и сборка LogQL (`docs/specs/logs.md`,
 * «CLI-контракт»). Всё чисто: ни сети, ни настоящих часов — момент
 * отсчёта передаётся параметром.
 */

import { describe, expect, it } from "vitest";
import { thrown } from "../testing/thrown.ts";
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

describe("--since: unix-ts, относительные единицы и отказ", () => {
  it("одни цифры — абсолютный ts, а не «столько назад»", () => {
    expect(parseSince("60")).toStrictEqual({
      kind: "absolute",
      unixSeconds: 60,
    });
    expect(windowStartMs(parseSince("60"), 5_000_000, 0)).toBe(60_000);
  });

  it("число с единицей — сдвиг назад от now", () => {
    const cases: readonly (readonly [string, number])[] = [
      ["30s", 30_000],
      ["10m", 600_000],
      ["1h", 3_600_000],
      ["2d", 172_800_000],
    ];
    for (const [raw, ms] of cases) {
      expect(parseSince(raw), raw).toStrictEqual({ kind: "relative", ms });
      expect(windowStartMs(parseSince(raw), 1_000_000_000, 0)).toStrictEqual(
        1_000_000_000 - ms,
      );
    }
  });

  it("прочее — ошибка ввода с текстом спеки", () => {
    const err = thrown(() => {
      parseSince("5x");
    }, UsageError);
    expect(err.message).toBe(
      "--since: ожидается <число>{s|m|h|d} или unix-ts, получено '5x'",
    );
    expect(() => parseSince("")).toThrow(UsageError);
    expect(() => parseSince("-1h")).toThrow(UsageError);
  });

  it("без --since окно — умолчание вызова", () => {
    expect(windowStartMs(undefined, 1_000_000, 300_000)).toBe(700_000);
  });
});

it("наносекунды считаются без потери разрядов", () => {
  // 1.7e18 не влезает в number: перевод обязан идти в BigInt.
  expect(toNanoseconds(1_754_380_800_123)).toStrictEqual(
    1_754_380_800_123_000_000n,
  );
});

describe("LogQL: порядок частей и экранирование", () => {
  it("без хоста — матчер всех хостов", () => {
    expect(buildLogQl(parts())).toBe('{host=~".+"}');
  });

  it("хост, сервис и потоки — один label-блок через запятую", () => {
    expect(
      buildLogQl(
        parts({
          host: "sl-1",
          service: "wb-loader",
          noStdout: true,
          noStderr: true,
        }),
      ),
    ).toStrictEqual(
      '{host="sl-1",compose_service="wb-loader",stream!="stdout",' +
        'stream!="stderr"}',
    );
  });

  it("фильтры: greps, regexes, client, level — в этом порядке", () => {
    expect(
      buildLogQl(
        parts({
          host: "sl-1",
          greps: ["первый", "второй"],
          regexes: ["ERR.*"],
          client: 4326,
          level: "ERROR",
        }),
      ),
    ).toStrictEqual(
      '{host="sl-1"} |= `первый` |= `второй` |~ `ERR.*` |= `4326`' +
        ' | detected_level="error"',
    );
  });

  it("label-значение экранирует обратный слэш и кавычку", () => {
    expect(buildLogQl(parts({ host: 'sl\\-"1"' }))).toBe(
      '{host="sl\\\\-\\"1\\""}',
    );
  });

  it("line-фильтр с backtick уходит в двойные кавычки", () => {
    expect(buildLogQl(parts({ greps: ["a`b", 'c"d'] }))).toBe(
      '{host=~".+"} |= "a`b" |= `c"d`',
    );
  });
});
