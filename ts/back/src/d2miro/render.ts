/**
 * Отрисовка плана на доске (`docs/specs/d2-miro.md`): позиция фрейма,
 * удаление одноимённого со всем содержимым, создание элементов,
 * коннекторы.
 *
 * Числа итога берутся из ответов службы, а не из длины плана: план —
 * намерение, а называть надо сделанное (`ts/CLAUDE.md`, «Величина
 * берётся там, где совершается работа»). Отсюда же счёт пропусков:
 * молчаливый успех при частично собранном фрейме недопустим — на
 * доске осталась бы картинка, которую оператор примет за целую.
 */

import {
  FRAME_GAP,
  MARKDOWN_BLOCK_HEIGHT,
  MARKDOWN_MARGIN,
  MIN_SHAPE_HEIGHT,
  MIN_SHAPE_WIDTH,
  MIN_TEXT_WIDTH,
} from "./geometry.ts";
import type { MiroBoard, MiroItem } from "./miro.ts";
import type { Plan, PlannedShape } from "./plan.ts";

/** Куда команда пишет ход исполнения (stderr точки входа). */
export interface RenderIo {
  readonly progress: (line: string) => void;
}

/** Центр фрейма на холсте. */
export interface Position {
  readonly x: number;
  readonly y: number;
}

/** Итог отрисовки — числами из ответов службы. */
export interface RenderCounts {
  readonly frameId: string;
  readonly shapes: number;
  readonly texts: number;
  readonly connectors: number;
  /** Элементы и рёбра, которые создать не удалось либо было нечем. */
  readonly skipped: number;
  /** Повторы запросов к службе за прогон. */
  readonly retries: number;
}

/** HTML-метка Miro: экранирование и переводы строк (спека). */
export function htmlLabel(text: string): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return escaped.replaceAll("\n", "<br/>");
}

/**
 * Позиция фрейма, первое сработавшее правило (спека): явная;
 * одноимённый фрейм — его же место; иначе правее самого правого;
 * фреймов нет — (200 + W/2, 0).
 */
export function framePosition(
  frames: readonly MiroItem[],
  existing: MiroItem | undefined,
  width: number,
  explicit: Position | undefined,
): Position {
  if (explicit !== undefined) return explicit;
  if (existing?.x !== undefined && existing.y !== undefined) {
    return { x: existing.x, y: existing.y };
  }
  const placed = frames.filter((frame) => frame.x !== undefined);
  if (placed.length === 0) return { x: FRAME_GAP + width / 2, y: 0 };
  const right = Math.max(
    ...placed.map((frame) => (frame.x ?? 0) + (frame.width ?? 0) / 2),
  );
  // Средний y — по фреймам с координатами: у фрейма без `position`
  // координаты нет вовсе, и включать его в среднее было бы
  // подстановкой нуля вместо неизвестного.
  const middle = placed.reduce((sum, frame) => sum + (frame.y ?? 0), 0) /
    placed.length;
  return { x: right + FRAME_GAP + width / 2, y: middle };
}

/** Пара разнонаправленных рёбер разводится привязками (спека). */
function snapOf(plan: Plan, src: string, dst: string): string | undefined {
  const opposite = plan.edges.some(
    (edge) => edge.src === dst && edge.dst === src,
  );
  if (!opposite) return undefined;
  return src < dst ? "top" : "bottom";
}

/**
 * Тело запроса шейпа: место — от угла фрейма, размеры — не меньше
 * минимума. У контейнера метка ставится сверху слева (спека): по
 * центру она легла бы поверх его же детей.
 *
 * `fillOpacity` задаётся явно: у элемента, созданного без него, служба
 * отвечает `"0.0"` (живая фикстура `shape-created.json`), то есть
 * заливка была бы прозрачной и цвет из исходника пропал бы.
 */
function shapeBody(
  shape: PlannedShape,
  frameId: string,
  container: boolean,
): unknown {
  return {
    data: {
      shape: shape.card ? "round_rectangle" : shape.miroShape,
      content: `<p>${htmlLabel(shape.label)}</p>`,
    },
    style: {
      fillColor: shape.fill ?? "#ffffff",
      fillOpacity: "1",
      borderColor: shape.stroke ?? "#1a1a1a",
      borderWidth: "1",
      borderStyle: "normal",
      color: "#1a1a1a",
      fontSize: "14",
      textAlign: container ? "left" : "center",
      textAlignVertical: container ? "top" : "middle",
    },
    position: { x: shape.x, y: shape.y },
    geometry: {
      width: Math.max(shape.width, MIN_SHAPE_WIDTH),
      height: Math.max(shape.height, MIN_SHAPE_HEIGHT),
    },
    parent: { id: frameId },
  };
}

/** Удаляет одноимённый фрейм: сперва детей, потом сам фрейм. */
async function removeFrame(
  board: MiroBoard,
  io: RenderIo,
  frame: MiroItem,
  title: string,
): Promise<void> {
  io.progress(`[info] removing existing frame '${title}' (${frame.id})`);
  // Дети удаляются сами: `DELETE /frames/{id}` их не трогает, они
  // остаются сиротами с `parent: null` (снято живьём,
  // `orphan-after-frame-delete.json`).
  for (const child of await board.children(frame.id)) {
    await board.remove("/items", child.id);
  }
  await board.remove("/frames", frame.id);
}

/** Отрисовывает план: возвращает числа, снятые с ответов службы. */
export async function renderPlan(
  board: MiroBoard,
  plan: Plan,
  explicit: Position | undefined,
  io: RenderIo,
): Promise<RenderCounts> {
  const frames = await board.frames();
  const existing = frames.find((frame) => frame.title === plan.title);
  const position = framePosition(frames, existing, plan.frameWidth, explicit);
  if (existing !== undefined) {
    await removeFrame(board, io, existing, plan.title);
  }
  const frameId = await board.create("/frames", {
    data: { title: plan.title, format: "custom", type: "freeform" },
    style: { fillColor: "#ffffff" },
    position,
    geometry: { width: plan.frameWidth, height: plan.frameHeight },
  });
  io.progress(
    `[info] created frame ${frameId} at (${position.x}, ${position.y})`,
  );

  let skipped = 0;
  const ids = new Map<string, string>();
  // Порядок — по имени: контейнер идёт раньше своих детей
  // (`recalc` < `recalc.check`), а этого и требует z-order спеки.
  for (const shape of plan.shapes) {
    // Контейнер — тот, чьё имя является префиксом имени другого шейпа:
    // вложенность в исходнике задаётся точкой (`recalc.check`).
    const container = plan.shapes.some((other) =>
      other.name.startsWith(`${shape.name}.`)
    );
    try {
      ids.set(
        shape.name,
        await board.create("/shapes", shapeBody(shape, frameId, container)),
      );
    } catch (err) {
      skipped++;
      io.progress(`[skip] shape ${shape.name}: ${reason(err)}`);
    }
  }

  let texts = 0;
  for (const [index, block] of plan.markdown.entries()) {
    // Таблицу спека велит рисовать сеткой шейпов, ячейка — отдельным.
    // Перенос этого не умеет, и потеря названа вслух: молчаливый
    // успех оставил бы на доске текст вместо таблицы, а оператор
    // принял бы его за сделанное (инвариант спеки).
    if (block.text.includes("|")) {
      io.progress(
        `[warn] markdown table in '${block.name}' rendered as text`,
      );
    }
    try {
      await board.create("/texts", {
        data: { content: `<p>${htmlLabel(block.text)}</p>` },
        position: {
          x: plan.frameWidth / 2,
          y: plan.diagramHeight + MARKDOWN_MARGIN +
            index * MARKDOWN_BLOCK_HEIGHT + MARKDOWN_BLOCK_HEIGHT / 2,
        },
        geometry: {
          width: Math.max(
            MIN_TEXT_WIDTH,
            plan.frameWidth - 2 * MARKDOWN_MARGIN,
          ),
        },
        parent: { id: frameId },
      });
      texts++;
    } catch (err) {
      skipped++;
      io.progress(`[skip] text ${block.name}: ${reason(err)}`);
    }
  }

  let connectors = 0;
  for (const edge of plan.edges) {
    const start = ids.get(edge.src);
    const end = ids.get(edge.dst);
    if (start === undefined || end === undefined) {
      const missing = [
        ...(start === undefined ? [edge.src] : []),
        ...(end === undefined ? [edge.dst] : []),
      ];
      skipped++;
      io.progress(
        `[skip] edge ${edge.src} -> ${edge.dst} (no shape: ` +
          `[${missing.map((name) => `'${name}'`).join(", ")}])`,
      );
      continue;
    }
    try {
      await board.create(
        "/connectors",
        connectorBody(plan, edge.src, edge.dst, start, end, edge.label),
      );
      connectors++;
    } catch (err) {
      skipped++;
      io.progress(
        `[skip] connector ${edge.src} -> ${edge.dst}: ${reason(err)}`,
      );
    }
  }

  return {
    frameId,
    shapes: ids.size,
    texts,
    connectors,
    skipped,
    retries: board.retries,
  };
}

/** Тело коннектора; метка — только когда она есть (спека). */
function connectorBody(
  plan: Plan,
  src: string,
  dst: string,
  start: string,
  end: string,
  label: string,
): unknown {
  const snap = snapOf(plan, src, dst);
  return {
    startItem: { id: start, ...(snap === undefined ? {} : { snapTo: snap }) },
    endItem: { id: end, ...(snap === undefined ? {} : { snapTo: snap }) },
    shape: "curved",
    style: { strokeColor: "#1a1a1a", strokeWidth: "1" },
    ...(label === "" ? {} : { captions: [{ content: htmlLabel(label) }] }),
  };
}

/** Причина пропуска одной строкой: текст ошибки без трейса. */
function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
