/**
 * Числа рендера, которых нет в спеке текстом (`d2-miro.md`, «Открытые
 * вопросы»): высота области markdown-блоков, минимальные размеры
 * элементов Miro, отступ фрейма от соседа.
 *
 * **Это догадки, а не снятые величины** — кроме тех двух, что сходятся
 * с голденом плана: у входа с одним markdown-блоком высота фрейма
 * 1146 → 1418, у входа без блоков 507 → 587. Отсюда `MARKDOWN_MARGIN`
 * 80 и `MARKDOWN_BLOCK_HEIGHT` 192: две точки, через которые проходит
 * прямая, а не подогнанная под один случай константа. Остальные числа
 * судит живая пара; каждое стоит здесь, а не по месту, чтобы правка
 * после пары была одна.
 */

/** Отступ области markdown-блоков снизу диаграммы. */
export const MARKDOWN_MARGIN = 80;

/** Высота одного markdown-блока в области под диаграммой. */
export const MARKDOWN_BLOCK_HEIGHT = 192;

/** Минимальные размеры шейпа Miro (`d2-miro.md`, «Miro API»). */
export const MIN_SHAPE_WIDTH = 60;
export const MIN_SHAPE_HEIGHT = 40;

/** Минимальная ширина текстового элемента Miro. */
export const MIN_TEXT_WIDTH = 200;

/** Зазор между самым правым фреймом доски и новым. */
export const FRAME_GAP = 200;

/** Высота фрейма: диаграмма плюс область блоков под ней. */
export function frameHeight(diagram: number, markdownBlocks: number): number {
  if (markdownBlocks === 0) return diagram + MARKDOWN_MARGIN;
  return diagram + MARKDOWN_MARGIN + markdownBlocks * MARKDOWN_BLOCK_HEIGHT;
}
