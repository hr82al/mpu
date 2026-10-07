/**
 * `mpu-back` глазами переводчика (`platform/mcp-objects.md`, «Отказы»):
 * погашенный `back` — повторы до срока, поднятый снова — работа без
 * перезапуска; отказы — своим текстом.
 */

import { expect, it } from "vitest";
import { BackLine } from "./back.ts";
import { QUICK } from "./testkit.ts";

const TARGET = { base: "http://127.0.0.1:1", token: "t", cwd: "/" };

/** `fetch`, отвечающий по очереди: `TypeError` — `back` не слушает. */
function scripted(answers: readonly (Response | "down")[]) {
  const queue = [...answers];
  let attempts = 0;
  const fetcher = (() => {
    attempts += 1;
    const next = queue.shift() ?? "down";
    if (next === "down") {
      return Promise.reject(new TypeError("connection refused"));
    }
    return Promise.resolve(next);
  }) as typeof fetch;
  return { fetcher, attempts: () => attempts };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

it("back погашен: повторы до срока, затем «недоступен»", async () => {
  const { fetcher, attempts } = scripted([]);
  const line = new BackLine(TARGET, QUICK, fetcher);
  expect(await line.start(["version"], false)).toStrictEqual({
    failed: "mpu-back недоступен на http://127.0.0.1:1",
  });
  expect(attempts() >= 2, `попыток ${attempts()}`).toBe(true);
});

it("back поднялся во время повторов — строка исполнена", async () => {
  const done = { stdout: "0.1.0\n", stderr: "", exit: 0 };
  const { fetcher, attempts } = scripted(["down", "down", json(done)]);
  const line = new BackLine(TARGET, QUICK, fetcher);
  expect(await line.start(["version"], false)).toStrictEqual({
    collected: done,
  });
  expect(attempts()).toBe(3);
});

it("отказы back: 401/403, истёкший номер, не по контракту", async () => {
  const cases: readonly (readonly [Response, string, "start" | "answer"])[] = [
    [
      new Response(null, { status: 401 }),
      "mpu-back отказал в доступе (401)",
      "start",
    ],
    [
      new Response(null, { status: 403 }),
      "mpu-back отказал в доступе (403)",
      "start",
    ],
    [
      json({ error: "номер подтверждения недействителен" }, 404),
      "подтверждение истекло",
      "answer",
    ],
    [json({ what: 1 }), "mpu-back ответил не по контракту (200)", "start"],
  ];
  for (const [response, text, call] of cases) {
    const line = new BackLine(TARGET, QUICK, scripted([response]).fetcher);
    const reply =
      call === "start"
        ? await line.start(["x"], false)
        : await line.answer("n1", "y");
    expect(reply).toStrictEqual({ failed: text });
  }
});

it("отмена в ожидании подъёма: ждать перестаём сразу", async () => {
  // Ждать поднятия `back` ради вызова, которого больше никто не
  // слушает, незачем (`platform/mcp-cancel.md`).
  const { fetcher, attempts } = scripted([]);
  const line = new BackLine(TARGET, QUICK, fetcher);
  const stop = new AbortController();
  const started = line.start(["version"], false, { signal: stop.signal });
  const before = attempts();
  stop.abort();
  await expect(started).rejects.toThrow();
  // После отмены ни одной новой попытки: пауза кончилась сигналом, а не
  // сроком.
  const after = attempts();
  await new Promise((resolve) => setTimeout(resolve, QUICK.everyMs * 3));
  expect(
    attempts(),
    `попытки после отмены: ${before} → ${after}`,
  ).toStrictEqual(after);
});

it("строка несёт caller сессии агента; сессии нет — поля нет", async () => {
  const bodies: unknown[] = [];
  const fetcher = ((_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Promise.resolve(json({ exit: 0, stdout: "", stderr: "" }));
  }) as typeof fetch;
  const line = new BackLine(TARGET, QUICK, fetcher);
  await line.start(["it"], false, { caller: "mcp:s1" });
  await line.start(["it"], false);
  expect(
    bodies.map((body) => (body as { caller?: string }).caller),
  ).toStrictEqual(["mcp:s1", undefined]);
});
