/**
 * Таблица контейнеров (`specs/ps.md`, `specs/health.md`): колонки по
 * ширине содержимого, разделитель — два пробела, выравнивание влево.
 *
 * Хвостовые пробелы срезаются: ширина последней колонки ни на что не
 * влияет, а дополненные строки ломают сравнение и мешают копированию
 * (отклонение `fix` обеих спек).
 */

/** Разделитель колонок. */
const GAP = "  ";

/** Строки таблицы вместе с шапкой; ячейки — уже готовый текст. */
export function renderTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length))
  );
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join(GAP)
        .trimEnd()
    )
    .map((line) => `${line}\n`)
    .join("");
}
