/**
 * Разбор SVG-рендера d2: viewBox и layout каждого шейпа
 * (`docs/specs/d2-miro.md`). Источник координат — только он: `.d2`
 * говорит, ЧТО рисовать, SVG — ГДЕ.
 *
 * Форма снята с настоящего рендера (`fixtures/d2-miro/sample.svg`,
 * `d2 v0.7.1`): имя шейпа лежит в `class` его группы, закодированное
 * base64 (`bG9hZGVy` → `loader`), а геометрия — внутри вложенной
 * группы `class="shape"`. У markdown-блока эта группа пуста, поэтому
 * layout'а у него нет вовсе — отсюда и предупреждение «in d2 source
 * but not in SVG» на живом входе.
 *
 * Разбор — регулярными выражениями, а не XML-парсером: нужны три
 * атрибута из плоской структуры, и тянуть парсер ради них незачем.
 * Именно поэтому берётся ПЕРВАЯ группа `shape` после заголовка группы
 * имени: вложенности у неё в этом рендере нет.
 */

/** Прямоугольник layout'а в координатах внутреннего viewBox. */
export interface SvgShape {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Разобранный рендер: рамка и шейпы с координатами. */
export interface SvgLayout {
  /** Размер внешнего viewBox — он же размер будущего фрейма. */
  readonly width: number;
  readonly height: number;
  /** Начало координат содержимого (внутренний viewBox). */
  readonly minX: number;
  readonly minY: number;
  readonly shapes: readonly SvgShape[];
}

/** SVG не разобран — рендерить нечего, и это отказ, а не пустой layout. */
export class SvgError extends Error {
  override readonly name = "SvgError";
}

const VIEW_BOX = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/g;
const GROUP = /<g class="([A-Za-z0-9+/=]{4,})"[^>]*>/g;
const RECT =
  /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)"/;
const PATH = /<path d="([^"]+)"/;
const NUMBER = /-?\d+(?:\.\d+)?/g;

/**
 * Имя группы: d2 кодирует его base64. Не base64 (или не UTF-8) —
 * группа не шейповая, такие в рендере есть (маркеры стрелок).
 */
function decodeName(encoded: string): string | undefined {
  try {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Группы рёбер называются `(a -&gt; b)[0]` — это связь, не шейп.
    return name.includes("->") || name.includes("-&gt;") ? undefined : name;
  } catch {
    // Мусорная строка в `class` — не имя; в рендере это служебные
    // группы, и молчать здесь правильно: отказ уронил бы весь рендер
    // из-за чужого элемента.
    return undefined;
  }
}

/** Габарит пути: числа `d` идут парами координат, кроме V/H. */
function pathBox(d: string): Omit<SvgShape, "name"> | undefined {
  const xs: number[] = [];
  const ys: number[] = [];
  for (
    const step of d.matchAll(
      /([MLCSQTAVHZmlcsqtavhz])([^MLCSQTAVHZmlcsqtavhz]*)/g,
    )
  ) {
    const [, command, tail] = step;
    const numbers = (tail.match(NUMBER) ?? []).map(Number);
    if (command === "V" || command === "v") {
      ys.push(...numbers);
      continue;
    }
    if (command === "H" || command === "h") {
      xs.push(...numbers);
      continue;
    }
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      xs.push(numbers[i]);
      ys.push(numbers[i + 1]);
    }
  }
  if (xs.length === 0 || ys.length === 0) return undefined;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Геометрия группы шейпа: прямоугольник как есть, иначе габарит пути. */
function boxOf(chunk: string): Omit<SvgShape, "name"> | undefined {
  const rect = RECT.exec(chunk);
  if (rect !== null) {
    return {
      x: Number(rect[1]),
      y: Number(rect[2]),
      width: Number(rect[3]),
      height: Number(rect[4]),
    };
  }
  const path = PATH.exec(chunk);
  return path === null ? undefined : pathBox(path[1]);
}

/**
 * Разбирает рендер. Без viewBox рендерить нечего — отказ: размер
 * фрейма брать неоткуда, а выдуманный поставил бы на доску картинку
 * неверного размера.
 */
export function parseSvg(text: string): SvgLayout {
  const boxes = [...text.matchAll(VIEW_BOX)];
  if (boxes.length === 0) throw new SvgError("в SVG нет viewBox");
  const outer = boxes[0];
  // Внутренний viewBox задаёт начало координат содержимого; его нет —
  // содержимое лежит в координатах внешнего.
  const inner = boxes[1] ?? outer;
  const shapes: SvgShape[] = [];
  for (const group of text.matchAll(GROUP)) {
    const name = decodeName(group[1]);
    if (name === undefined) continue;
    const start = group.index + group[0].length;
    const shapeGroup = /<g class="shape"[^>]*>([\s\S]*?)<\/g>/.exec(
      text.slice(start, start + 4096),
    );
    if (shapeGroup === null) continue;
    const box = boxOf(shapeGroup[1]);
    if (box === undefined) continue;
    shapes.push({ name, ...box });
  }
  return {
    width: Number(outer[3]),
    height: Number(outer[4]),
    minX: Number(inner[1]),
    minY: Number(inner[2]),
    shapes,
  };
}
