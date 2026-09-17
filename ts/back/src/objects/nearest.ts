/** Сколько правок отделяет одно слово от другого (Левенштейн). */
function distance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let previous = right.map((_, i) => i + 1);
  previous.unshift(0);
  for (const [i, char] of left.entries()) {
    const current = [i + 1];
    for (const [j, other] of right.entries()) {
      const cost = char === other ? 0 : 1;
      current.push(
        Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

const MAX_DISTANCE = 2;
const MAX_SHOWN = 3;

/**
 * Близкие к слову селекторы: не дальше двух правок, не больше трёх, по
 * возрастанию расстояния, при равенстве — по алфавиту.
 */
export function nearest(word: string, selectors: readonly string[]): string[] {
  return selectors
    .map((selector) => ({ selector, far: distance(word, selector) }))
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
