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

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseD2 } from "./d2.ts";
import { parseSvg } from "./svg.ts";
import { buildPlan, infoLine, planText, warnLines } from "./plan.ts";

const dir = new URL("testdata/d2-miro/", import.meta.url);

async function read(name: string): Promise<string> {
  return await readFile(new URL(name, dir), "utf8");
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

it("правильный вход: план и строки повторяют голден дословно", async () => {
  const plan = await planOf("sample");
  const golden = streams(await read("sample-dry-run.txt"));
  expect(planText(plan)).toStrictEqual(golden.stdout);
  expect([...warnLines(plan), infoLine("sample.d2", plan)].join("\n"))
    .toStrictEqual(golden.stderr);
  // Числа входа — те, что у объекта: контейнер считается шейпом,
  // markdown-блок — нет, ребро в контейнер и ребро в блок считаются.
  expect([plan.shapes.length, plan.edges.length, plan.markdown.length])
    .toStrictEqual([5, 5, 1]);
  // Размер фрейма выше диаграммы на область блоков.
  expect([plan.frameWidth, plan.frameHeight]).toStrictEqual([478, 1418]);
});

it("кириллический вход: потеря вида названа числом, а не только предупреждением", async () => {
  const plan = await planOf("sample-cyrillic");
  const golden = streams(await read("sample-cyrillic-dry-run.txt"));
  // План совпадает с объектом дословно: шейпы приходят из SVG,
  // умолчанием, и ребро с меткой разбирается, хотя имён шейпов
  // разбор не увидел.
  expect(planText(plan)).toStrictEqual(golden.stdout);
  expect(warnLines(plan)).toStrictEqual([
    "[warn] in SVG but not in d2 source: ['витрина', 'загрузчик']",
  ]);
  // А вот `[info]` расходится с объектом намеренно: у него потеря
  // `shape:` и markdown-блока проходила молча при коде 0. Осознанное
  // расхождение (`d2-miro.md`, «Поддерживаемое подмножество D2»):
  // счёт в итоговой строке.
  const info = infoLine("sample-cyrillic.d2", plan);
  expect(info.endsWith("; 2 without a source pair"), info).toBe(true);
  expect(
    golden.stderr.split("\n").some((line) => line.includes("without a source")),
    "голден объекта такого счёта не содержит — расхождение осознанное",
  ).toBe(false);
  expect(plan.shapes.every((shape) => !shape.paired)).toBe(true);
});

it("координаты ребёнка — от левого верхнего угла фрейма", async () => {
  const plan = await planOf("sample");
  const loader = plan.shapes.find((shape) => shape.name === "loader");
  // SVG: x=77, y=0 при начале координат (-91, -101), размер 143x66.
  // Miro адресует ребёнка центром от угла фрейма
  // (`relativeTo: "parent_top_left"`, живая фикстура
  // `frame-children.json`), абсолютные координаты служба отвергает
  // 400 «outside of parent boundaries».
  expect([loader?.x, loader?.y]).toStrictEqual([239.5, 134]);
  // И ни один шейп не выходит за фрейм — иначе это тот самый 400.
  for (const shape of plan.shapes) {
    expect(shape.x - shape.width / 2 >= 0, `${shape.name}: левее`).toBe(true);
    expect(shape.y - shape.height / 2 >= 0, `${shape.name}: выше`).toBe(true);
    expect(
      shape.x + shape.width / 2 <= plan.frameWidth,
      `${shape.name}: правее фрейма`,
    ).toBe(true);
    expect(
      shape.y + shape.height / 2 <= plan.frameHeight,
      `${shape.name}: ниже фрейма`,
    ).toBe(true);
  }
});

it("вид исходника переводится в вид Miro, незнакомый — прямоугольник", async () => {
  const plan = await planOf("sample");
  const kinds = new Map(plan.shapes.map((s) => [s.name, s.miroShape]));
  // `can` — единственный перевод, снятый голденом; остальное по
  // совпадению имени, и незнакомое имя не роняет рендер.
  expect(kinds.get("mart")).toBe("can");
  expect(kinds.get("loader")).toBe("rectangle");
});
