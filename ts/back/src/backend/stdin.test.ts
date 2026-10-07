/**
 * Ввод клиента по запросу строки (`platform/stdin-on-request.md`):
 * сервер просит ввод кадром `stdinRequest`, только когда строке он
 * нужен, и не чаще одного раза; простой HTTP поле не читает.
 */

import { describe, expect, it } from "vitest";
import { MAX_STDIN_BYTES } from "../frames/mod.ts";
import { CANCELLED_CODE } from "./stopping.ts";
import {
  Client,
  type Frame,
  line,
  ndjson,
  post,
  request,
  type TestBack,
  withBack,
} from "./testback.ts";

/** Строка с вводом по запросу; `stdin` — ответ клиента на запрос. */
async function requested(
  back: TestBack,
  words: readonly string[],
  options: { readonly stdin?: string; readonly answers?: string[] } = {},
): Promise<Frame[]> {
  const client = new Client(back, "/line", options);
  await client.opened();
  client.send({ words, cwd: process.cwd(), human: true, stdinOnRequest: true });
  return await client.finished();
}

/** Сколько раз сервер просил ввод. */
function requests(frames: readonly Frame[]): number {
  return frames.filter((frame) => "stdinRequest" in frame).length;
}

it("строка без чтения ввода: кадра запроса нет", () =>
  withBack(async (back) => {
    const frames = await requested(back, ["version"], { stdin: "x" });
    expect(requests(frames)).toBe(0);
    expect(frames.at(-1)).toStrictEqual({ exit: 0 });
  }));

it("два чтения ввода в строке: один запрос, одно содержимое", () =>
  withBack(async (back) => {
    // Группа читает ввод своей командой, внешняя команда — ещё раз.
    const frames = await requested(
      back,
      ["confirm", "yes", "text:", "do", "confirm", "yes", "end"],
      { stdin: "ok" },
    );
    expect(requests(frames)).toBe(1);
    expect(frames).toStrictEqual([
      { stdinRequest: true },
      { err: "ok\n" },
      { err: "ok\n" },
      { out: "ok" },
      { exit: 0 },
    ]);
  }));

it("кадр stdin без запроса — игнорируется", () =>
  withBack(async (back) => {
    // Правило `ask` держит строку до ответа: лишний кадр гарантированно
    // приходит раньше запроса.
    await line(back, "/line", ["ask:", "confirm"], ["y"]);
    const client = new Client(back, "/line", { stdin: "настоящий" });
    await client.opened();
    client.send({
      words: ["ask", "confirm", "yes"],
      cwd: process.cwd(),
      human: true,
      stdinOnRequest: true,
    });
    await client.frame((frame) => "ask" in frame);
    client.send({ stdin: "лишний" });
    client.answer("y");
    expect(await client.finished()).toStrictEqual([
      { ask: "выполнить mpu confirm yes? [y/N] " },
      { stdinRequest: true },
      { err: "настоящий\n" },
      { out: "настоящий" },
      { exit: 0 },
    ]);
  }));

describe("плохие поля ввода в первом кадре: отказ, код 2", () => {
  const bad: readonly Record<string, unknown>[] = [
    { stdinOnRequest: true, stdin: "x" },
    { stdinOnRequest: "yes" },
  ];
  for (const fields of bad) {
    it(JSON.stringify(fields), () =>
      withBack(async (back) => {
        const client = new Client(back, "/line");
        await client.opened();
        client.send({ words: ["version"], cwd: process.cwd(), ...fields });
        expect(await client.finished()).toStrictEqual([
          { err: "mpu-back: плохой кадр строки\n" },
          { exit: 2 },
        ]);
        expect(back.called).toStrictEqual([]);
      }),
    );
  }
});

it("ввод сверх предела после запроса: отказ, код 2, вывода нет", async () => {
  const codes: number[] = [];
  let diagnosed: readonly string[] = [];
  await withBack(
    async (back) => {
      const frames = await requested(back, ["confirm", "yes"], {
        stdin: "a".repeat(MAX_STDIN_BYTES + 1),
      });
      expect(frames).toStrictEqual([
        { stdinRequest: true },
        { err: "mpu-back: ввод больше 8 МиБ\n" },
        { exit: 2 },
      ]);
      diagnosed = back.diagnosed;
    },
    { finishedWith: (code) => void codes.push(code) },
  );
  // Команду остановили, как при обрыве: запись журнала — кодом
  // остановленной строки, сбоя строки нет.
  expect(codes).toStrictEqual([CANCELLED_CODE]);
  expect(diagnosed).toStrictEqual([]);
});

it("дверь ask: ввод запрашивается после ответа «да»", () =>
  withBack(async (back) => {
    await line(back, "/line", ["ask:", "confirm"], ["y"]);
    const frames = await requested(back, ["ask", "confirm", "yes"], {
      stdin: "данные",
      answers: ["y"],
    });
    expect(frames).toStrictEqual([
      { ask: "выполнить mpu confirm yes? [y/N] " },
      { stdinRequest: true },
      { err: "данные\n" },
      { out: "данные" },
      { exit: 0 },
    ]);
  }));

describe("простой HTTP: stdinOnRequest не читается любым значением", () => {
  const bodies: readonly Record<string, unknown>[] = [
    { stdinOnRequest: "yes" },
    { stdinOnRequest: true },
  ];
  for (const fields of bodies) {
    it(JSON.stringify(fields), () =>
      withBack(async (back) => {
        const response = await post(back, "/line", {
          words: ["confirm", "yes"],
          cwd: process.cwd(),
          ...fields,
        });
        expect(await ndjson(back, response)).toStrictEqual([
          { err: "\n" },
          { out: "" },
          { exit: 0 },
        ]);
      }),
    );
  }
  it("поле stdin — как прежде", () =>
    withBack(async (back) => {
      const response = await post(back, "/line", {
        words: ["confirm", "yes"],
        cwd: process.cwd(),
        stdinOnRequest: true,
        stdin: "тело",
      });
      expect(await ndjson(back, response)).toStrictEqual([
        { err: "тело\n" },
        { out: "тело" },
        { exit: 0 },
      ]);
    }));
});

it("клиент ушёл, пока сервер ждёт ввод: строка не висит", async () => {
  const codes: number[] = [];
  let diagnosed: readonly string[] = [];
  await withBack(
    async (back) => {
      const client = new Client(back, "/line");
      await client.opened();
      client.send({
        words: ["confirm", "yes"],
        cwd: process.cwd(),
        human: true,
        stdinOnRequest: true,
      });
      await client.frame((frame) => "stdinRequest" in frame);
      client.close();
      await client.closed();
      // Ожидание ввода снято обрывом: строка кончилась, и выход из
      // `withBack` (остановка ждёт исполнение всех строк) это подтверждает.
      expect((await request(back, "/health")).status).toBe(200);
      diagnosed = back.diagnosed;
    },
    { finishedWith: (code) => void codes.push(code) },
  );
  expect(codes).toStrictEqual([CANCELLED_CODE]);
  expect(diagnosed).toStrictEqual([]);
});
