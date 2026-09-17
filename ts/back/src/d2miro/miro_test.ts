/**
 * Клиент Miro против форм, снятых с живой службы
 * (`testdata/d2-miro/*.json` — копии канала). Сети здесь нет: фейковый
 * `fetch` отдаёт снятые тела и снятые коды, а сон подменён — иначе
 * проверка повторов шла бы минуты.
 *
 * Живой доски эти проверки не заменяют: они держат форму границы, а не
 * поведение службы. Пара с настоящим Miro — за спецификатором.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { MiroBoard, MiroError } from "./miro.ts";

const dir = new URL("testdata/d2-miro/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, dir));
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
        const body = reply.status === 204 ? null : reply.body ?? "";
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

Deno.test("500 повторяется, повторы считаются и названы в stderr", async () => {
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
  assertEquals(id, "3458764682192590187");
  assertEquals(stand.calls.length, 3);
  assertEquals(stand.board.retries, 2, "повторы обязаны считаться");
  assertEquals(stand.slept, [1000, 2000]);
  assertEquals(stand.notes.length, 2);
  assertStringIncludes(stand.notes[0], "[miro] 500 from service, retry 1");
});

Deno.test("429 спит столько, сколько велел Retry-After", async () => {
  const stand = boardWith([
    { status: 429, body: "", headers: { "retry-after": "5" } },
    { status: 200, body: '{"data":[],"cursor":""}' },
  ]);
  await stand.board.frames();
  assertEquals(stand.slept, [5000]);
  assertEquals(stand.notes, ["[miro] 429 rate-limit, sleep 5s"]);
});

Deno.test("отказ не повторяется, в тексте нет токена", async () => {
  // Форма отказа снята живьём: 400 с телом о границах родителя.
  const stand = boardWith([
    { status: 400, body: await fixture("child-absolute-position-400.json") },
  ]);
  const err = await assertRejects(
    () => stand.board.create("/shapes", { position: { x: 0, y: 0 } }),
    MiroError,
  );
  assertEquals(stand.calls.length, 1, "не-повторяемый отказ повторён");
  assertStringIncludes(err.message, "miro POST /shapes -> 400");
  assertStringIncludes(err.message, "outside of parent boundaries");
  // Инвариант спеки: токен не попадает ни в вывод, ни в тексты ошибок.
  assertEquals(err.message.includes("секрет-токена"), false);
  assertEquals(stand.notes.join("").includes("секрет-токена"), false);
  // А в заголовке он, разумеется, есть — иначе службе нечего проверять.
  assertEquals(stand.calls[0].auth, "Bearer секрет-токена");
});

Deno.test("повторяемый отказ не вечен: попытки кончаются отказом", async () => {
  const stand = boardWith([{ status: 503, body: "gateway" }]);
  const err = await assertRejects(
    () => stand.board.create("/frames", {}),
    MiroError,
  );
  assertEquals(err.status, 503);
  assertEquals(stand.calls.length, 6, "потолок попыток — 6 (спека)");
  assertEquals(stand.board.retries, 5);
});

Deno.test("сбой обращения — свой класс отказа, а не сырой TypeError", async () => {
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
  const err = await assertRejects(() => board.frames(), MiroError);
  assertStringIncludes(err.message, "transport error");
  assertEquals(err.message.includes("секрет-токена"), false);
  // Повтора у сбоя обращения нет: неверный заголовок повторять
  // бессмысленно, а сеть повторит вызывающий.
  assertEquals(board.retries, 0);
});

Deno.test("листинг идёт по всем страницам, а не по первой", async () => {
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
  assertEquals(frames.map((frame) => frame.id), ["1", "2"]);
  assertEquals(stand.calls.length, 2);
  assertStringIncludes(stand.calls[0].url, "/items?type=frame&limit=50");
  assertStringIncludes(stand.calls[1].url, "cursor=c2");
});

Deno.test("дети фрейма читаются в форме живого ответа", async () => {
  const stand = boardWith([{
    status: 200,
    body: await fixture("frame-children.json"),
  }]);
  const children = await stand.board.children("3458764682192590187");
  assertEquals(children.length, 3);
  assertEquals(children[0].id, "3458764682192590497");
  assertStringIncludes(
    stand.calls[0].url,
    "parent_item_id=3458764682192590187",
  );
});

Deno.test("коннектор создаётся кодом 200, а не 201", async () => {
  // Отпечаток службы: у коннектора код успеха другой, чем у прочих.
  const stand = boardWith([
    { status: 200, body: await fixture("connector-created.json") },
  ]);
  assertEquals(
    await stand.board.create("/connectors", {}),
    "3458764682192590530",
  );
});

Deno.test("удаление: 404 — успех, 400 locked — разлочить и повторить", async (t) => {
  await t.step("уже удалён", async () => {
    const stand = boardWith([
      { status: 404, body: '{"code":"3.0201"}' },
    ]);
    await stand.board.remove("/items", "42");
    assertEquals(stand.calls.length, 1);
  });

  await t.step("залочен — снимаем блокировку и удаляем ещё раз", async () => {
    const stand = boardWith([
      { status: 400, body: '{"message":"item is locked"}' },
      { status: 200, body: await fixture("patch-unlock.json") },
      { status: 204, body: "" },
    ]);
    await stand.board.remove("/items", "42");
    assertEquals(
      stand.calls.map((call) => call.method),
      ["DELETE", "PATCH", "DELETE"],
    );
    // Тело снятия блокировки — то, что приняла живая служба.
    assertEquals(stand.calls[1].body, '{"data":{"locked":false}}');
  });

  await t.step("иной отказ не глотается", async () => {
    const stand = boardWith([{ status: 403, body: "нет прав" }]);
    await assertRejects(() => stand.board.remove("/frames", "42"), MiroError);
  });
});
