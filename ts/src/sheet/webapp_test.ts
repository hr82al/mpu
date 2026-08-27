/**
 * Транспорт webapp (`platform/webapp-http.md`, «Ответ и retry»):
 * ветки повторов и тексты отказов. Сеть подставная, пауз нет.
 */

import { assertEquals, assertRejects } from "@std/assert";
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

Deno.test("успешный вызов: тело запроса и результат", async () => {
  const { deps, calls } = channel([ok({ sheets: [] })]);
  const result = await callWebapp(deps, "spreadsheets/get", { ssId: "id-1" });
  assertEquals(JSON.parse(calls[0]), {
    action: "spreadsheets/get",
    ssId: "id-1",
  });
  assertEquals(result, { sheets: [] });
});

Deno.test("не-объектный результат оборачивается в value", async () => {
  const { deps } = channel([ok(42)]);
  assertEquals(await callWebapp(deps, "act", {}), { value: 42 });
});

Deno.test("5xx повторяется с backoff и заметками в журнал", async () => {
  const { deps, pauses, notes, calls } = channel([
    { status: 500, text: "боль" },
    { status: 502, text: "боль" },
    ok({ ok: true }),
  ]);
  assertEquals(await callWebapp(deps, "act", {}), { ok: true });
  assertEquals(calls.length, 3);
  // 250 мс × 2ⁿ без jitter'а (random здесь ноль).
  assertEquals(pauses, [250, 500]);
  assertEquals(notes.length, 2);
  assertEquals(notes[0].includes("HTTP 500"), true);
});

Deno.test("шесть транспортных отказов — ошибка с их причиной", async () => {
  const { deps, calls } = channel([new Error("connection reset")]);
  const err = await assertRejects(
    () => callWebapp(deps, "act", {}),
    DomainError,
  );
  assertEquals(
    err.message,
    "act failed after 6 attempts: transport: connection reset",
  );
  assertEquals(calls.length, 6);
});

Deno.test("429 и квота в теле ждут минуту и повторяются", async (t) => {
  await t.step("по коду", async () => {
    const { deps, pauses } = channel([
      { status: 429, text: "" },
      ok({ ok: true }),
    ]);
    await callWebapp(deps, "act", {});
    assertEquals(pauses, [60_000]);
  });

  await t.step("по тексту тела", async () => {
    const { deps, pauses } = channel([
      { status: 200, text: "Quota Exceeded for this app" },
      ok({ ok: true }),
    ]);
    await callWebapp(deps, "act", {});
    assertEquals(pauses, [60_000]);
  });

  await t.step("по ошибке в успешном ответе", async () => {
    const { deps, pauses } = channel([
      { status: 200, text: JSON.stringify({ success: false, error: "Quota" }) },
      ok({ ok: true }),
    ]);
    await callWebapp(deps, "act", {});
    assertEquals(pauses, [60_000]);
  });
});

Deno.test("шесть подряд квот — исчерпанный бюджет с пустым хвостом", async () => {
  const { deps, pauses } = channel([{ status: 429, text: "" }]);
  const err = await assertRejects(
    () => callWebapp(deps, "act", {}),
    DomainError,
  );
  assertEquals(err.message, "act: исчерпан лимит попыток (6). Last error: ");
  assertEquals(pauses.length, 6);
});

Deno.test("404 терпится трижды, четвёртый — ошибка", async () => {
  const { deps, pauses, calls } = channel([{ status: 404, text: "<html>" }]);
  const err = await assertRejects(
    () => callWebapp(deps, "act", {}),
    DomainError,
  );
  assertEquals(err.message, "act: HTTP 404: <html>");
  assertEquals(calls.length, 4);
  assertEquals(pauses, [10_000, 10_000, 10_000]);
});

Deno.test("404 считаются подряд идущими, а не всего за вызов", async () => {
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
  assertEquals(await callWebapp(deps, "act", {}), { ok: true });
  assertEquals(calls.length, 6);
});

Deno.test("прочий 4xx — немедленный отказ без повторов", async () => {
  const { deps, calls } = channel([{ status: 403, text: "forbidden" }]);
  const err = await assertRejects(
    () => callWebapp(deps, "act", {}),
    DomainError,
  );
  assertEquals(err.message, "act: HTTP 403: forbidden");
  assertEquals(calls.length, 1);
});

Deno.test("тело не JSON и не объект — свои тексты", async (t) => {
  await t.step("не JSON", async () => {
    const { deps } = channel([{ status: 200, text: "<html>вход</html>" }]);
    const err = await assertRejects(
      () => callWebapp(deps, "act", {}),
      DomainError,
    );
    assertEquals(err.message, "act: non-JSON response: <html>вход</html>");
  });

  await t.step("JSON, но не объект", async () => {
    const { deps } = channel([{ status: 200, text: "[1,2]" }]);
    const err = await assertRejects(
      () => callWebapp(deps, "act", {}),
      DomainError,
    );
    assertEquals(err.message, "act: response is not an object: [1,2]");
  });
});

Deno.test("ложный success без квоты завершает вызов сразу", async (t) => {
  await t.step("с текстом ошибки", async () => {
    const { deps, calls } = channel([
      {
        status: 200,
        text: JSON.stringify({ success: false, error: "нет доступа" }),
      },
    ]);
    const err = await assertRejects(
      () => callWebapp(deps, "act", {}),
      DomainError,
    );
    assertEquals(err.message, "act: нет доступа");
    assertEquals(calls.length, 1);
  });

  await t.step("без текста ошибки", async () => {
    const { deps } = channel([
      { status: 200, text: JSON.stringify({ success: false }) },
    ]);
    const err = await assertRejects(
      () => callWebapp(deps, "act", {}),
      DomainError,
    );
    assertEquals(err.message, "act: unknown error");
  });
});

Deno.test("URL не появляется ни в одном тексте отказа", async () => {
  const { deps } = channel([{ status: 403, text: "forbidden" }]);
  const err = await assertRejects(
    () => callWebapp(deps, "act", {}),
    DomainError,
  );
  // Публичный deployment: знание адреса равносильно доступу к таблицам.
  assertEquals(err.message.includes("script.google.com"), false);
  assertEquals(err.message.includes("секрет"), false);
});

Deno.test("backoff растёт до потолка и добавляет jitter", () => {
  assertEquals(backoffMs(0, () => 0), 250);
  assertEquals(backoffMs(3, () => 0), 2000);
  assertEquals(backoffMs(10, () => 0), 8000);
  // Jitter — до четверти паузы, не больше.
  assertEquals(backoffMs(0, () => 1), 313);
});
