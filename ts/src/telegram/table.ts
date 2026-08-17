/**
 * Выравнивание таблиц подкоманд `telegram`: ширины колонок по
 * содержимому. Оформление, а не контракт — контракт это состав и
 * порядок колонок и итоговая строка (`docs/specs/telegram-ls.md`,
 * `docs/specs/telegram-search.md`, «Ввод/вывод»).
 */

/**
 * Строки в столбцы: клетки дополняются пробелами до ширины колонки,
 * хвостовые пробелы срезаются. Перевода строки в конце нет — его
 * добавляет вызывающий вместе с итоговой строкой.
 */
export function alignedRows(rows: readonly (readonly string[])[]): string {
  const widths = columnWidths(rows);
  return rows
    .map((row) =>
      row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()
    )
    .join("\n");
}

function columnWidths(rows: readonly (readonly string[])[]): readonly number[] {
  const widths = new Array<number>(rows[0].length).fill(0);
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], [...cell].length);
    });
  }
  return widths;
}
