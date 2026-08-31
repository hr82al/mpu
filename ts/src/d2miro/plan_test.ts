/**
 * Разбор входа и план — против голденов, снятых с объекта
 * (`docs/specs/fixtures/d2-miro/`, рендер настоящим `d2 v0.7.1`).
 *
 * Голден в канале — один файл, но в нём смешаны два потока: план идёт
 * в stdout, `[warn]` и `[info]` — в stderr, и порядок между ними в
 * записи зависит от буферизации (у двух снятых голденов он разный).
 * Поэтому сверяется каждый поток отдельно, а не файл целиком: сверять
 * перемешанное значило бы закреплять артефакт записи.
 */

import { assertEquals } from "@std/assert";
import { parseD2 } from "./d2.ts";
import { parseSvg } from "./svg.ts";
import { buildPlan, infoLine, planText, warnLines } from "./plan.ts";

const dir = new URL("testdata/d2-miro/", import.meta.url);

async function read(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, dir));
}

/** Голден, разложенный по потокам: план — stdout, прочее — stderr. */
function streams(golden: string): { stdout: string; stderr: string } {
  const lines = golden.split("\n").filter((line) => line !== "");
  const stdout = lines.filter((line) =>
    line.startsWith("[dry-run]") || line.startsWith("  ")
  );
  const stderr = lines.filter((line) =>
    line.startsWith("[warn]") || line.startsWith("[info]")
  );
  return { stdout: `${stdout.join("\n")}\n`, stderr: stderr.join("\n") };
}

async function planOf(base: string) {
  const source = parseD2(await read(`${base}.d2`));
  const layout = parseSvg(await read(`${base}.svg`));
  return buildPlan(base, source, layout);
}

Deno.test("правильный вход: план и строки повторяют голден дословно", async () => {
  const plan = await planOf("sample");
  const golden = streams(await read("sample-dry-run.txt"));
  assertEquals(planText(plan), golden.stdout);
  assertEquals(
    [...warnLines(plan), infoLine("sample.d2", plan)].join("\n"),
    golden.stderr,
  );
  // Числа входа — те, что у объекта: контейнер считается шейпом,
  // markdown-блок — нет, ребро в контейнер и ребро в блок считаются.
  assertEquals(
    [plan.shapes.length, plan.edges.length, plan.markdown.length],
    [5, 5, 1],
  );
  // Размер фрейма выше диаграммы на область блоков.
  assertEquals([plan.frameWidth, plan.frameHeight], [478, 1418]);
});

Deno.test("кириллический вход: потеря вида названа числом, а не только предупреждением", async () => {
  const plan = await planOf("sample-cyrillic");
  const golden = streams(await read("sample-cyrillic-dry-run.txt"));
  // План совпадает с объектом дословно: шейпы приходят из SVG,
  // умолчанием, и ребро с меткой разбирается, хотя имён шейпов
  // разбор не увидел.
  assertEquals(planText(plan), golden.stdout);
  assertEquals(warnLines(plan), [
    "[warn] in SVG but not in d2 source: ['витрина', 'загрузчик']",
  ]);
  // А вот `[info]` расходится с объектом намеренно: у него потеря
  // `shape:` и markdown-блока проходила молча при коде 0. Осознанное
  // расхождение (`d2-miro.md`, «Поддерживаемое подмножество D2»):
  // счёт в итоговой строке.
  const info = infoLine("sample-cyrillic.d2", plan);
  assertEquals(info.endsWith("; 2 without a source pair"), true, info);
  assertEquals(
    golden.stderr.split("\n").some((line) => line.includes("without a source")),
    false,
    "голден объекта такого счёта не содержит — расхождение осознанное",
  );
  assertEquals(plan.shapes.every((shape) => !shape.paired), true);
});

Deno.test("координаты ребёнка — от левого верхнего угла фрейма", async () => {
  const plan = await planOf("sample");
  const loader = plan.shapes.find((shape) => shape.name === "loader");
  // SVG: x=77, y=0 при начале координат (-91, -101), размер 143x66.
  // Miro адресует ребёнка центром от угла фрейма
  // (`relativeTo: "parent_top_left"`, живая фикстура
  // `frame-children.json`), абсолютные координаты служба отвергает
  // 400 «outside of parent boundaries».
  assertEquals([loader?.x, loader?.y], [239.5, 134]);
  // И ни один шейп не выходит за фрейм — иначе это тот самый 400.
  for (const shape of plan.shapes) {
    assertEquals(shape.x - shape.width / 2 >= 0, true, `${shape.name}: левее`);
    assertEquals(shape.y - shape.height / 2 >= 0, true, `${shape.name}: выше`);
    assertEquals(
      shape.x + shape.width / 2 <= plan.frameWidth,
      true,
      `${shape.name}: правее фрейма`,
    );
    assertEquals(
      shape.y + shape.height / 2 <= plan.frameHeight,
      true,
      `${shape.name}: ниже фрейма`,
    );
  }
});

Deno.test("вид исходника переводится в вид Miro, незнакомый — прямоугольник", async () => {
  const plan = await planOf("sample");
  const kinds = new Map(plan.shapes.map((s) => [s.name, s.miroShape]));
  // `can` — единственный перевод, снятый голденом; остальное по
  // совпадению имени, и незнакомое имя не роняет рендер.
  assertEquals(kinds.get("mart"), "can");
  assertEquals(kinds.get("loader"), "rectangle");
});
