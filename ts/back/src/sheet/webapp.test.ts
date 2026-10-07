/**
 * Транспорт webapp (`platform/webapp-http.md`, «Ответ и retry»):
 * ветки повторов и тексты отказов. Сеть подставная, пауз нет.
 */

import { assert, describe, expect, it } from "vitest";
import { DomainError } from "../command/mod.ts";
import { backoffMs, callWebapp, type WebappDeps } from "./webapp.ts";

/** Подставной канал: отдаёт заготовленные ответы по порядку. */
function channel(
  replies: readonly (
    | { readonly status: number; readonly text: string }
    | Error
  )[],
) {
  const calls: string[] = [];
  const pauses: number[] = [];
  const notes: string[] = [];
  let index = 0;
  const deps: WebappDeps = {
    url: "https://script.google.com/macros/s/секрет/exec",
    note: (line) => void notes.push(line),
    post: (_url, body) => {
      calls.push(body);
      const reply = replies[Math.min(index++, replies.length - 1)];
      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(reply);
    },
    // Пауз в тестах нет: они считаются, а не выжидаются.
    sleep: (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  };
  return { deps, calls, pauses, notes };
}

const ok = (result: unknown) => ({
  status: 200,
  text: JSON.stringify({ success: true, result }),
});

it("успешный вызов: тело запроса и результат", async () => {
  const { deps, calls } = channel([ok({ sheets: [] })]);
  const result = await callWebapp(deps, "spreadsheets/get", { ssId: "id-1" });
  expect(JSON.parse(calls[0])).toStrictEqual({
    action: "spreadsheets/get",
    ssId: "id-1",
  });
  expect(result).toStrictEqual({ sheets: [] });
});

it("не-объектный результат оборачивается в value", async () => {
  const { deps } = channel([ok(42)]);
  expect(await callWebapp(deps, "act", {})).toStrictEqual({ value: 42 });
});

it("5xx повторяется с backoff и заметками в журнал", async () => {
  const { deps, pauses, notes, calls } = channel([
    { status: 500, text: "боль" },
    { status: 502, text: "боль" },
    ok({ ok: true }),
  ]);
  expect(await callWebapp(deps, "act", {})).toStrictEqual({ ok: true });
  expect(calls.length).toBe(3);
  // 250 мс × 2ⁿ без jitter'а (random здесь ноль).
  expect(pauses).toStrictEqual([250, 500]);
  expect(notes.length).toBe(2);
  expect(notes[0].includes("HTTP 500")).toBe(true);
});

it("шесть транспортных отказов — ошибка с их причиной", async () => {
  const { deps, calls } = channel([new Error("connection reset")]);
  const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
    thrown
  );
  assert(err instanceof DomainError);
  expect(err.message).toBe(
    "act failed after 6 attempts: transport: connection reset",
  );
  expect(calls.length).toBe(6);
});

describe("429 и квота в теле ждут минуту и повторяются", () => {
  it("по коду", async () => {
    const { deps, pauses } = channel([
      { status: 429, text: "" },
      ok({ ok: true }),
    ]);
    await callWebapp(deps, "act", {});
    expect(pauses).toStrictEqual([60_000]);
  });

  it("по тексту тела", async () => {
    const { deps, pauses } = channel([
      { status: 200, text: "Quota Exceeded for this app" },
      ok({ ok: true }),
    ]);
    await callWebapp(deps, "act", {});
    expect(pauses).toStrictEqual([60_000]);
  });

  it("по ошибке в успешном ответе", async () => {
    const { deps, pauses } = channel([
      { status: 200, text: JSON.stringify({ success: false, error: "Quota" }) },
      ok({ ok: true }),
    ]);
    await callWebapp(deps, "act", {});
    expect(pauses).toStrictEqual([60_000]);
  });
});

it("шесть подряд квот — исчерпанный бюджет с пустым хвостом", async () => {
  const { deps, pauses } = channel([{ status: 429, text: "" }]);
  const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
    thrown
  );
  assert(err instanceof DomainError);
  expect(err.message).toBe("act: исчерпан лимит попыток (6). Last error: ");
  expect(pauses.length).toBe(6);
});

it("404 терпится трижды, четвёртый — ошибка", async () => {
  const { deps, pauses, calls } = channel([{ status: 404, text: "<html>" }]);
  const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
    thrown
  );
  assert(err instanceof DomainError);
  expect(err.message).toBe("act: HTTP 404: <html>");
  expect(calls.length).toBe(4);
  expect(pauses).toStrictEqual([10_000, 10_000, 10_000]);
});

it("404 считаются подряд идущими, а не всего за вызов", async () => {
  // 404 → 500 → 404 → 404 → 404: подряд их только три, и на последнем
  // вызов обязан продолжиться, а не упасть (атом, «Ответ и retry»).
  const { deps, calls } = channel([
    { status: 404, text: "<html>" },
    { status: 500, text: "боль" },
    { status: 404, text: "<html>" },
    { status: 404, text: "<html>" },
    { status: 404, text: "<html>" },
    ok({ ok: true }),
  ]);
  expect(await callWebapp(deps, "act", {})).toStrictEqual({ ok: true });
  expect(calls.length).toBe(6);
});

it("прочий 4xx — немедленный отказ без повторов", async () => {
  const { deps, calls } = channel([{ status: 403, text: "forbidden" }]);
  const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
    thrown
  );
  assert(err instanceof DomainError);
  expect(err.message).toBe("act: HTTP 403: forbidden");
  expect(calls.length).toBe(1);
});

describe("тело не JSON и не объект — свои тексты", () => {
  it("не JSON", async () => {
    const { deps } = channel([{ status: 200, text: "<html>вход</html>" }]);
    const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
      thrown
    );
    assert(err instanceof DomainError);
    expect(err.message).toBe("act: non-JSON response: <html>вход</html>");
  });

  it("JSON, но не объект", async () => {
    const { deps } = channel([{ status: 200, text: "[1,2]" }]);
    const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
      thrown
    );
    assert(err instanceof DomainError);
    expect(err.message).toBe("act: response is not an object: [1,2]");
  });
});

describe("ложный success без квоты завершает вызов сразу", () => {
  it("с текстом ошибки", async () => {
    const { deps, calls } = channel([
      {
        status: 200,
        text: JSON.stringify({ success: false, error: "нет доступа" }),
      },
    ]);
    const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
      thrown
    );
    assert(err instanceof DomainError);
    expect(err.message).toBe("act: нет доступа");
    expect(calls.length).toBe(1);
  });

  it("без текста ошибки", async () => {
    const { deps } = channel([
      { status: 200, text: JSON.stringify({ success: false }) },
    ]);
    const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
      thrown
    );
    assert(err instanceof DomainError);
    expect(err.message).toBe("act: unknown error");
  });
});

it("URL не появляется ни в одном тексте отказа", async () => {
  const { deps } = channel([{ status: 403, text: "forbidden" }]);
  const err = await callWebapp(deps, "act", {}).catch((thrown: unknown) =>
    thrown
  );
  assert(err instanceof DomainError);
  // Публичный deployment: знание адреса равносильно доступу к таблицам.
  expect(err.message.includes("script.google.com")).toBe(false);
  expect(err.message.includes("секрет")).toBe(false);
});

it("backoff растёт до потолка и добавляет jitter", () => {
  expect(backoffMs(0, () => 0)).toBe(250);
  expect(backoffMs(3, () => 0)).toBe(2000);
  expect(backoffMs(10, () => 0)).toBe(8000);
  // Jitter — до четверти паузы, не больше.
  expect(backoffMs(0, () => 1)).toBe(313);
});
