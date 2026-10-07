/**
 * Клиент Miro против форм, снятых с живой службы
 * (`testdata/d2-miro/*.json` — копии канала). Сети здесь нет: фейковый
 * `fetch` отдаёт снятые тела и снятые коды, а сон подменён — иначе
 * проверка повторов шла бы минуты.
 *
 * Живой доски эти проверки не заменяют: они держат форму границы, а не
 * поведение службы. Пара с настоящим Miro — за спецификатором.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { MiroBoard, MiroError } from "./miro.ts";

const dir = new URL("testdata/d2-miro/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(name, dir), "utf8");
}

/** Очередь ответов: по одному на запрос, в порядке очереди. */
interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body?: string;
  readonly auth?: string;
}

function boardWith(replies: readonly Reply[]) {
  const calls: Recorded[] = [];
  const slept: number[] = [];
  const notes: string[] = [];
  let index = 0;
  const board = new MiroBoard(
    {
      fetch: (url, init) => {
        calls.push({
          method: init.method,
          url,
          body: init.body,
          auth: init.headers["authorization"],
        });
        const reply = replies[Math.min(index++, replies.length - 1)];
        // 204 запрещает тело — это код удаления, и пустая строка ему
        // не подходит: `Response` бросает.
        const body = reply.status === 204 ? null : (reply.body ?? "");
        return Promise.resolve(
          new Response(body, { status: reply.status, headers: reply.headers }),
        );
      },
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      note: (line) => void notes.push(line),
    },
    "uXjVJqkHSQc=",
    "секрет-токена",
  );
  return { board, calls, slept, notes };
}

it("500 повторяется, повторы считаются и названы в stderr", async () => {
  // Замер спецификатора: `POST /frames` отвечает 500 примерно в
  // половине попыток при живой квоте, и повтор лечит. Оригинал
  // повторяет только 429 — это и есть осознанное расхождение.
  const created = await fixture("frame-created.json");
  const stand = boardWith([
    { status: 500, body: '{"code":"3.0000","message":"Internal error"}' },
    { status: 500, body: '{"code":"3.0000","message":"Internal error"}' },
    { status: 201, body: created },
  ]);
  const id = await stand.board.create("/frames", { data: { title: "проба" } });
  expect(id).toBe("3458764682192590187");
  expect(stand.calls.length).toBe(3);
  expect(stand.board.retries, "повторы обязаны считаться").toBe(2);
  expect(stand.slept).toStrictEqual([1000, 2000]);
  expect(stand.notes.length).toBe(2);
  expect(stand.notes[0]).toContain("[miro] 500 from service, retry 1");
});

it("429 спит столько, сколько велел Retry-After", async () => {
  const stand = boardWith([
    { status: 429, body: "", headers: { "retry-after": "5" } },
    { status: 200, body: '{"data":[],"cursor":""}' },
  ]);
  await stand.board.frames();
  expect(stand.slept).toStrictEqual([5000]);
  expect(stand.notes).toStrictEqual(["[miro] 429 rate-limit, sleep 5s"]);
});

it("отказ не повторяется, в тексте нет токена", async () => {
  // Форма отказа снята живьём: 400 с телом о границах родителя.
  const stand = boardWith([
    { status: 400, body: await fixture("child-absolute-position-400.json") },
  ]);
  const err = await rejected(
    () => stand.board.create("/shapes", { position: { x: 0, y: 0 } }),
    MiroError,
  );
  expect(stand.calls.length, "не-повторяемый отказ повторён").toBe(1);
  expect(err.message).toContain("miro POST /shapes -> 400");
  expect(err.message).toContain("outside of parent boundaries");
  // Инвариант спеки: токен не попадает ни в вывод, ни в тексты ошибок.
  expect(err.message.includes("секрет-токена")).toBe(false);
  expect(stand.notes.join("").includes("секрет-токена")).toBe(false);
  // А в заголовке он, разумеется, есть — иначе службе нечего проверять.
  expect(stand.calls[0].auth).toBe("Bearer секрет-токена");
});

it("повторяемый отказ не вечен: попытки кончаются отказом", async () => {
  const stand = boardWith([{ status: 503, body: "gateway" }]);
  const err = await rejected(
    () => stand.board.create("/frames", {}),
    MiroError,
  );
  expect(err.status).toBe(503);
  expect(stand.calls.length, "потолок попыток — 6 (спека)").toBe(6);
  expect(stand.board.retries).toBe(5);
});

it("сбой обращения — свой класс отказа, а не сырой TypeError", async () => {
  // Замер 2026-08-31 на собранном бинаре: токен с кириллицей роняет
  // `fetch` до всякой сети («headers is not a valid ByteString»), и
  // без своего класса это уходило наружу «unexpected error» с трейсом
  // — чего отклонение-fix спеки прямо запрещает.
  const board = new MiroBoard(
    {
      fetch: () => Promise.reject(new TypeError("headers not a ByteString")),
      sleep: () => Promise.resolve(),
      note: () => {},
    },
    "b",
    "секрет-токена",
  );
  const err = await rejected(() => board.frames(), MiroError);
  expect(err.message).toContain("transport error");
  expect(err.message.includes("секрет-токена")).toBe(false);
  // Повтора у сбоя обращения нет: неверный заголовок повторять
  // бессмысленно, а сеть повторит вызывающий.
  expect(board.retries).toBe(0);
});

it("листинг идёт по всем страницам, а не по первой", async () => {
  // Страница `limit=50` обрезает молча: сравнение первых 50 элементов
  // дало бы ложное «состав совпал» (замер спецификатора).
  const stand = boardWith([
    {
      status: 200,
      body: JSON.stringify({
        data: [{ id: "1", type: "frame", data: { title: "первый" } }],
        cursor: "c2",
      }),
    },
    {
      status: 200,
      body: JSON.stringify({
        data: [{ id: "2", type: "frame", data: { title: "второй" } }],
        cursor: "",
      }),
    },
  ]);
  const frames = await stand.board.frames();
  expect(frames.map((frame) => frame.id)).toStrictEqual(["1", "2"]);
  expect(stand.calls.length).toBe(2);
  expect(stand.calls[0].url).toContain("/items?type=frame&limit=50");
  expect(stand.calls[1].url).toContain("cursor=c2");
});

it("дети фрейма читаются в форме живого ответа", async () => {
  const stand = boardWith([
    {
      status: 200,
      body: await fixture("frame-children.json"),
    },
  ]);
  const children = await stand.board.children("3458764682192590187");
  expect(children.length).toBe(3);
  expect(children[0].id).toBe("3458764682192590497");
  expect(stand.calls[0].url).toContain("parent_item_id=3458764682192590187");
});

it("коннектор создаётся кодом 200, а не 201", async () => {
  // Отпечаток службы: у коннектора код успеха другой, чем у прочих.
  const stand = boardWith([
    { status: 200, body: await fixture("connector-created.json") },
  ]);
  expect(await stand.board.create("/connectors", {})).toBe(
    "3458764682192590530",
  );
});

describe("удаление: 404 — успех, 400 locked — разлочить и повторить", () => {
  it("уже удалён", async () => {
    const stand = boardWith([{ status: 404, body: '{"code":"3.0201"}' }]);
    await stand.board.remove("/items", "42");
    expect(stand.calls.length).toBe(1);
  });

  it("залочен — снимаем блокировку и удаляем ещё раз", async () => {
    const stand = boardWith([
      { status: 400, body: '{"message":"item is locked"}' },
      { status: 200, body: await fixture("patch-unlock.json") },
      { status: 204, body: "" },
    ]);
    await stand.board.remove("/items", "42");
    expect(stand.calls.map((call) => call.method)).toStrictEqual([
      "DELETE",
      "PATCH",
      "DELETE",
    ]);
    // Тело снятия блокировки — то, что приняла живая служба.
    expect(stand.calls[1].body).toBe('{"data":{"locked":false}}');
  });

  it("иной отказ не глотается", async () => {
    const stand = boardWith([{ status: 403, body: "нет прав" }]);
    await expect(stand.board.remove("/frames", "42")).rejects.toThrow(
      MiroError,
    );
  });
});
