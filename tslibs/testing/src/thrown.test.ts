/**
 * Контракт пойманной ошибки: ответ — сама ошибка; отсутствие ошибки, не тот
 * класс и не тот текст — красный тест (`AssertionError` Vitest).
 */

import { describe, expect, it } from "vitest";
import { rejected, thrown } from "../thrown.ts";

class Expected extends Error {
  override name = "Expected";
}

/** Ошибка утверждения, которой краснеет помощник. */
function failure(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("помощник не покраснел");
}

/** То же для асинхронного помощника. */
async function failureOf(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("помощник не покраснел");
}

describe("thrown", () => {
  it("возвращает брошенную ошибку нужного класса", () => {
    const error = new Expected("disk is full");
    expect(
      thrown(
        () => {
          throw error;
        },
        Expected,
        "full",
      ),
    ).toBe(error);
  });

  it("без броска — красный", () => {
    expect(failure(() => thrown(() => 1, Expected)).message).toContain(
      "ожидалась ошибка, а её не было",
    );
  });

  it("не тот класс — красный с именем ожидаемого", () => {
    const fn = () => {
      throw new TypeError("x");
    };
    expect(failure(() => thrown(fn, Expected)).message).toContain(
      "ожидалась Expected",
    );
  });

  it("текст без нужной подстроки — красный", () => {
    const fn = () => {
      throw new Expected("disk is full");
    };
    expect(() => thrown(fn, Expected, "absent")).toThrow();
  });
});

describe("rejected", () => {
  it("возвращает ошибку отказа нужного класса", async () => {
    const error = new Expected("timeout");
    expect(await rejected(() => Promise.reject(error), Expected)).toBe(error);
  });

  it("исполненный промис — красный", async () => {
    const error = await failureOf(() =>
      rejected(() => Promise.resolve(1), Expected),
    );
    expect(error.message).toContain("ожидался отказ, а промис исполнился");
  });

  it("не тот класс — красный с именем ожидаемого", async () => {
    const error = await failureOf(() =>
      rejected(() => Promise.reject(new TypeError("x")), Expected),
    );
    expect(error.message).toContain("ожидалась Expected");
  });

  it("текст без нужной подстроки — красный", async () => {
    const error = await failureOf(() =>
      rejected(
        () => Promise.reject(new Expected("timeout")),
        Expected,
        "absent",
      ),
    );
    expect(error.message).toContain("absent");
  });
});
