/**
 * План рендера: что из `.d2` и SVG станет элементами доски
 * (`docs/specs/d2-miro.md`). Один и тот же план печатает `--dry-run` и
 * исполняет рендер — иначе печать и исполнение разошлись бы, и это уже
 * записано отклонением-fix в спеке.
 *
 * Шейпы плана берутся из SVG: только у них есть layout. Вид, метка и
 * стиль — из `.d2`, когда имя нашло пару; не нашло — умолчания, и это
 * **считается**, а не только предупреждается (см. `unpaired`).
 */

import type { D2Edge, D2Markdown, D2Shape, D2Source } from "./d2.ts";
import { frameHeight } from "./geometry.ts";
import type { SvgLayout, SvgShape } from "./svg.ts";

/** Элемент плана: шейп с местом на доске и видом. */
export interface PlannedShape {
  readonly name: string;
  /** Вид из исходника (`cylinder`); без пары — `rectangle`. */
  readonly kind: string;
  /** Вид Miro, в котором шейп создаётся (`can` для `cylinder`). */
  readonly miroShape: string;
  readonly card: boolean;
  readonly label: string;
  readonly fill?: string;
  readonly stroke?: string;
  /** Центр относительно левого верхнего угла фрейма (`parent_top_left`). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Имя нашло пару в исходнике; нет — вид и стиль потеряны. */
  readonly paired: boolean;
}

/** Ребро плана: имена как в исходнике. */
export type PlannedEdge = D2Edge;

/** Полный план рендера. */
export interface Plan {
  readonly title: string;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly diagramWidth: number;
  readonly diagramHeight: number;
  readonly shapes: readonly PlannedShape[];
  readonly edges: readonly PlannedEdge[];
  readonly markdown: readonly D2Markdown[];
  /** Имена, разошедшиеся между исходником и SVG. */
  readonly svgOnly: readonly string[];
  readonly sourceOnly: readonly string[];
}

/**
 * Виды d2 → виды Miro. Снято голденом только для двух: `rectangle`
 * остаётся собой, `cylinder` становится `can`. Остальные проходят
 * по совпадению имени со списком Miro, а незнакомое — прямоугольник:
 * рисунок не тем видом лучше отказа посреди отрисовки, и расхождение
 * видно на доске сразу.
 */
const MIRO_SHAPE: Readonly<Record<string, string>> = {
  rectangle: "rectangle",
  square: "square",
  circle: "circle",
  oval: "oval",
  ellipse: "oval",
  cylinder: "can",
  diamond: "rhombus",
  hexagon: "hexagon",
  cloud: "cloud",
  document: "document",
  parallelogram: "parallelogram",
  triangle: "triangle",
  star: "star",
};

/** Вид Miro для вида исходника; незнакомый — прямоугольник. */
export function miroShapeOf(kind: string): string {
  return MIRO_SHAPE[kind] ?? "rectangle";
}

/** Собирает план из разобранного исходника и layout'а SVG. */
export function buildPlan(
  title: string,
  source: D2Source,
  layout: SvgLayout,
): Plan {
  const declared = new Map(source.shapes.map((shape) => [shape.name, shape]));
  const shapes = layout.shapes
    .map((shape) => plannedShape(shape, declared.get(shape.name), layout))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  const laidOut = new Set(layout.shapes.map((shape) => shape.name));
  const sourceNames = [
    ...source.shapes.map((shape) => shape.name),
    ...source.markdown.map((block) => block.name),
  ];
  return {
    title,
    frameWidth: layout.width,
    frameHeight: frameHeight(layout.height, source.markdown.length),
    diagramWidth: layout.width,
    diagramHeight: layout.height,
    shapes,
    edges: source.edges,
    markdown: source.markdown,
    svgOnly: [...laidOut].filter((name) => !declared.has(name)).sort(),
    sourceOnly: sourceNames.filter((name) => !laidOut.has(name)).sort(),
  };
}

/** Шейп плана: место — из SVG, вид и стиль — из исходника, если он есть. */
function plannedShape(
  shape: SvgShape,
  declared: D2Shape | undefined,
  layout: SvgLayout,
): PlannedShape {
  const kind = declared?.kind ?? "rectangle";
  return {
    name: shape.name,
    kind,
    miroShape: miroShapeOf(kind),
    card: declared?.card === true,
    label: declared?.label ?? shape.name,
    fill: declared?.fill,
    stroke: declared?.stroke,
    // Центр относительно левого верхнего угла фрейма: именно так Miro
    // адресует ребёнка (`relativeTo: "parent_top_left"`, живая
    // фикстура `frame-children.json`). Абсолютные координаты служба
    // отвергает `400 "new position is outside of parent boundaries"`.
    x: shape.x - layout.minX + shape.width / 2,
    y: shape.y - layout.minY + shape.height / 2,
    width: shape.width,
    height: shape.height,
    paired: declared !== undefined,
  };
}

/** Строка `[info]`: числа входа и размеры (`d2-miro.md`, «Ввод/вывод»). */
export function infoLine(fileName: string, plan: Plan): string {
  const base = `[info] ${fileName}: ${plan.shapes.length} shapes, ` +
    `${plan.edges.length} edges, ${plan.markdown.length} markdown blocks; ` +
    `viewBox ${number(plan.diagramWidth)}x${number(plan.diagramHeight)} -> ` +
    `frame ${number(plan.frameWidth)}x${number(plan.frameHeight)} ` +
    `(scale=1.000)`;
  // Счёт вместо молчания: у объекта потеря вида и markdown-блока
  // проходила предупреждением при коде 0, и план выглядел выполненным
  // (`d2-miro.md`, «Поддерживаемое подмножество D2»). Осознанное
  // расхождение с оригиналом: число в итоговой строке, а не отказ, —
  // спека сама велит рисовать такой шейп умолчанием.
  const lost = plan.shapes.filter((shape) => !shape.paired).length;
  return lost === 0 ? base : `${base}; ${lost} without a source pair`;
}

/** Предупреждения о расхождении имён — в порядке спеки. */
export function warnLines(plan: Plan): readonly string[] {
  const lines: string[] = [];
  if (plan.sourceOnly.length > 0) {
    lines.push(`[warn] in d2 source but not in SVG: ${list(plan.sourceOnly)}`);
  }
  if (plan.svgOnly.length > 0) {
    lines.push(`[warn] in SVG but not in d2 source: ${list(plan.svgOnly)}`);
  }
  return lines;
}

/** Печать плана `--dry-run` (stdout). */
export function planText(plan: Plan): string {
  const lines = ["[dry-run] would create:"];
  for (const shape of plan.shapes) {
    const target = shape.card ? "card" : `shape(${shape.miroShape})`;
    lines.push(`  ${target.padEnd(20)} ${shape.name}  kind=${shape.kind}`);
  }
  for (const edge of plan.edges) {
    lines.push(
      `  edge   ${edge.src} -> ${edge.dst}  label='${label(edge.label)}'`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Метка ребра в плане — до 30 символов (спека). */
function label(text: string): string {
  return text.length <= 30 ? text : text.slice(0, 30);
}

/** Список имён в форме объекта: `['a', 'b']`. */
function list(names: readonly string[]): string {
  return `[${names.map((name) => `'${name}'`).join(", ")}]`;
}

/** Целые печатаются без дробной части — как у объекта. */
function number(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}
