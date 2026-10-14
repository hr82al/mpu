/**
 * Патч `git diff -U0`: куски, каждый со своими строками рабочего
 * дерева. Разбор один на всех, кто спрашивает о диффе (`--base` у
 * `code literals` и `code shape`).
 *
 * Строки куска забираются по счёту из его заголовка, а не по первому
 * символу: в `-U0` строка содержимого `---` (удалённый `--`) выглядит
 * как заголовок следующего файла.
 */

/** Кусок диффа: строки новой стороны, которые он поставил. */
export class Hunk {
  constructor(
    private readonly first: number,
    private readonly count: number,
  ) {}

  /** Строки рабочего дерева куска; у чистого удаления их нет. */
  lines(): readonly number[] {
    return Array.from({ length: this.count }, (_, i) => this.first + i);
  }
}

/** Заголовок куска: `@@ -начало[,число] +начало[,число] @@`. */
const HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Строка-примечание `\ No newline at end of file` в счёт куска не входит. */
const NOTE = "\\";

/** Читает куски патча `git diff -U0` по порядку. */
export function readHunks(text: string): readonly Hunk[] {
  const lines = text.split("\n");
  const hunks: Hunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const header = HEADER.exec(lines[index++]);
    if (header === null) continue;
    const [, removed, start, added] = header;
    // Без числа сторона куска — одна строка.
    const oldCount = removed === undefined ? 1 : Number(removed);
    const newCount = added === undefined ? 1 : Number(added);
    index = skipBody(lines, index, oldCount + newCount);
    hunks.push(new Hunk(Number(start), newCount));
  }
  return hunks;
}

/** Индекс строки за содержимым куска из `size` строк. */
function skipBody(
  lines: readonly string[],
  from: number,
  size: number,
): number {
  let index = from;
  let left = size;
  while (left > 0 && index < lines.length) {
    if (!lines[index].startsWith(NOTE)) left--;
    index++;
  }
  while (index < lines.length && lines[index].startsWith(NOTE)) index++;
  return index;
}
