import { levenshteinDistance } from "@std/text/levenshtein-distance";

const MAX_DISTANCE = 2;
const MAX_SHOWN = 3;

/**
 * Близкие к слову селекторы: не дальше двух правок и меньше правок, чем букв
 * в селекторе, не больше трёх, по возрастанию расстояния, при равенстве — по
 * алфавиту.
 */
export function nearest(word: string, selectors: readonly string[]): string[] {
  return selectors
    .map((selector) => ({ selector, far: levenshteinDistance(word, selector) }))
    .filter((near) => near.far <= reach(near.selector))
    .sort((a, b) => a.far - b.far || order(a.selector, b.selector))
    .slice(0, MAX_SHOWN)
    .map((near) => near.selector);
}

/**
 * Сколько правок допустимо до селектора. Короткому селектору — меньше: иначе
 * двухбуквенный `it` в двух правках от любого четырёхбуквенного слова
 * (`kitn`), и подсказка перестаёт что-либо значить.
 */
function reach(selector: string): number {
  return Math.min(MAX_DISTANCE, selector.length - 1);
}

/** Алфавитный порядок селекторов — тот же, что у `Array.prototype.sort`. */
export function order(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
