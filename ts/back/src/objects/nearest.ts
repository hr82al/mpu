import { levenshteinDistance } from "@std/text/levenshtein-distance";

const MAX_DISTANCE = 2;
const MAX_SHOWN = 3;

/**
 * Близкие к слову селекторы: не дальше двух правок, не больше трёх, по
 * возрастанию расстояния, при равенстве — по алфавиту.
 */
export function nearest(word: string, selectors: readonly string[]): string[] {
  return selectors
    .map((selector) => ({ selector, far: levenshteinDistance(word, selector) }))
    .filter((near) => near.far <= MAX_DISTANCE)
    .sort((a, b) => a.far - b.far || order(a.selector, b.selector))
    .slice(0, MAX_SHOWN)
    .map((near) => near.selector);
}

/** Алфавитный порядок селекторов — тот же, что у `Array.prototype.sort`. */
export function order(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
