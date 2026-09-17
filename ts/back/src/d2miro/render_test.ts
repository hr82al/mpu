/**
 * Отрисовка плана против фейковой службы на настоящем клиенте: тела
 * запросов, порядок вызовов и числа итога. Формы ответов — снятые
 * (`testdata/d2-miro/*.json`), сети нет.
 *
 * Живой доски это не заменяет: здесь проверяется, ЧТО команда шлёт, а
 * не что с этим делает Miro. Пара с настоящей доской — за
 * спецификатором.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { MiroBoard } from "./miro.ts";
import { buildPlan } from "./plan.ts";
import { parseD2 } from "./d2.ts";
import { parseSvg } from "./svg.ts";
import { framePosition, htmlLabel, renderPlan } from "./render.ts";

const dir = new URL("testdata/d2-miro/", import.meta.url);

async function samplePlan(title = "sample") {
  const source = parseD2(await Deno.readTextFile(new URL("sample.d2", dir)));
  const layout = parseSvg(await Deno.readTextFile(new URL("sample.svg", dir)));
  return buildPlan(title, source, layout);
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/** Фейк доски: отвечает по пути и записывает каждый вызов по порядку. */
function stand(
  opts: {
    frames?: unknown[];
    children?: unknown[];
    failShape?: string;
    failText?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const progress: string[] = [];
  let created = 0;
  const board = new MiroBoard(
    {
      fetch: (url, init) => {
        const path = url.replace(/^.*\/boards\/[^/]+/, "");
        const body = init.body === undefined
          ? undefined
          : JSON.parse(init.body) as Record<string, unknown>;
        calls.push({ method: init.method, path, body });
        if (init.method === "GET" && path.includes("parent_item_id")) {
          return json({ data: opts.children ?? [], cursor: "" });
        }
        if (init.method === "GET") {
          return json({ data: opts.frames ?? [], cursor: "" });
        }
        if (init.method === "DELETE") {
          return Promise.resolve(
            new Response(null, { status: 204 }),
          );
        }
        if (opts.failText === true && path === "/texts") {
          return Promise.resolve(
            new Response('{"message":"boom"}', { status: 400 }),
          );
        }
        const content = (body?.data as { content?: string } | undefined)
          ?.content;
        if (
          opts.failShape !== undefined && content !== undefined &&
          content.includes(opts.failShape)
        ) {
          return Promise.resolve(
            new Response('{"message":"boom"}', { status: 400 }),
          );
        }
        created++;
        return json(
          { id: `id-${created}` },
          path === "/connectors" ? 200 : 201,
        );
      },
      sleep: () => Promise.resolve(),
      note: (line) => void progress.push(line),
    },
    "board=1",
    "секрет",
  );
  return { board, calls, progress };
}

function json(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(value), { status }),
  );
}

Deno.test("на пустой доске: фрейм, шейпы в порядке имён, коннекторы", async () => {
  const plan = await samplePlan();
  const board = stand();
  const progress: string[] = [];
  const counts = await renderPlan(board.board, plan, undefined, {
    progress: (line) => void progress.push(line),
  });
  const posts = board.calls.filter((call) => call.method === "POST");
  assertEquals(posts[0].path, "/frames");
  // Контейнер раньше своих детей — этого требует z-order спеки.
  const shapeNames = posts
    .filter((call) => call.path === "/shapes")
    .map((call) => (call.body as { data: { content: string } }).data.content);
  assertEquals(shapeNames.length, 5);
  assertStringIncludes(shapeNames[2], "Пересчёт");
  assertStringIncludes(shapeNames[3], "Сверка со стендом");
  // Числа — из ответов службы: пять шейпов, один текст, четыре
  // коннектора (пятое ребро ведёт в markdown-блок, шейпа у него нет).
  assertEquals(
    [counts.shapes, counts.texts, counts.connectors, counts.skipped],
    [5, 1, 4, 1],
  );
  assertEquals(
    progress.some((line) =>
      line.startsWith("[skip] edge recalc.report -> card (no shape:")
    ),
    true,
    progress.join("\n"),
  );
  // Пустая доска — фрейм правее нуля на зазор плюс половина ширины.
  const frame = posts[0].body as { position: { x: number; y: number } };
  assertEquals(frame.position, { x: 200 + 478 / 2, y: 0 });
});

Deno.test("повторный рендер: дети удаляются раньше фрейма", async () => {
  // `DELETE /frames/{id}` детей не трогает — они остаются сиротами
  // (снято живьём). Поэтому порядок вызовов и есть проверяемое
  // свойство: сперва каждый ребёнок, потом фрейм.
  const plan = await samplePlan("прежний");
  const board = stand({
    frames: [{
      id: "f1",
      type: "frame",
      data: { title: "прежний" },
      position: { x: 10, y: 20 },
      geometry: { width: 100, height: 100 },
    }],
    children: [
      { id: "c1", type: "shape" },
      { id: "c2", type: "shape" },
    ],
  });
  const progress: string[] = [];
  await renderPlan(board.board, plan, undefined, {
    progress: (line) => void progress.push(line),
  });
  const deletes = board.calls
    .filter((call) => call.method === "DELETE")
    .map((call) => call.path);
  assertEquals(deletes, ["/items/c1", "/items/c2", "/frames/f1"]);
  // Позиция сохранена: единственный случай, когда она не из правила и
  // не из флага (инвариант спеки).
  const frame = board.calls.find((call) => call.path === "/frames");
  assertEquals(
    (frame?.body as { position: unknown }).position,
    { x: 10, y: 20 },
  );
  assertStringIncludes(progress[0], "[info] removing existing frame 'прежний'");
});

Deno.test("отказ на одном элементе не рвёт рендер, но считается", async () => {
  const plan = await samplePlan();
  const board = stand({ failShape: "Витрина" });
  const progress: string[] = [];
  const counts = await renderPlan(board.board, plan, undefined, {
    progress: (line) => void progress.push(line),
  });
  // Четыре шейпа из пяти, и оба ребра упавшего шейпа пропущены.
  assertEquals(counts.shapes, 4);
  // Ровно пять и не «не меньше»: сам шейп, три ребра, у которых он
  // конец или начало, и ребро в markdown-блок, у которого шейпа нет
  // вовсе. «Не меньше» пропустило бы мутацию, завышающую пропуски.
  assertEquals(counts.skipped, 5);
  assertEquals(
    progress.some((line) => line.startsWith("[skip] shape mart:")),
    true,
    progress.join("\n"),
  );
});

Deno.test("падение текста считается: числа берутся с ответов, не с плана", async () => {
  const plan = await samplePlan();
  const board = stand({ failText: true });
  const progress: string[] = [];
  const counts = await renderPlan(board.board, plan, undefined, {
    progress: (line) => void progress.push(line),
  });
  // Текст не создан — и это видно числом, а не только строкой:
  // `texts: plan.markdown.length` прошёл бы молча.
  assertEquals(counts.texts, 0);
  assertEquals(counts.shapes, 5);
  assertEquals(
    progress.some((line) => line.startsWith("[skip] text card:")),
    true,
    progress.join("\n"),
  );
});

Deno.test("позиция фрейма: правило за правилом", async (t) => {
  const frames = [
    { id: "a", type: "frame", x: 0, y: 100, width: 200, height: 100 },
    { id: "b", type: "frame", x: 400, y: 300, width: 100, height: 100 },
  ];
  await t.step("явная позиция старше всего", () => {
    assertEquals(
      framePosition(frames, frames[0], 478, { x: 7, y: 8 }),
      { x: 7, y: 8 },
    );
  });
  await t.step("одноимённый фрейм — его место", () => {
    assertEquals(framePosition(frames, frames[1], 478, undefined), {
      x: 400,
      y: 300,
    });
  });
  await t.step("иначе правее самого правого, по среднему y", () => {
    assertEquals(framePosition(frames, undefined, 478, undefined), {
      x: 450 + 200 + 239,
      y: 200,
    });
  });
  await t.step("фреймов нет — у нуля", () => {
    assertEquals(framePosition([], undefined, 478, undefined), {
      x: 439,
      y: 0,
    });
  });
});

Deno.test("метка уходит HTML'ем: экранирование и переводы строк", () => {
  assertEquals(htmlLabel("a & b < c"), "a &amp; b &lt; c");
  assertEquals(htmlLabel("две\nстроки"), "две<br/>строки");
});
