/**
 * Формы вывода результата `mpu sql-ro` (`specs/sql-ro.md`, «Ввод/вывод»):
 * ASCII-таблица по умолчанию, `--json` и `--md`. Чистые функции над
 * результатом первого оператора — ни соединения, ни аргументов команды
 * этот слой не знает.
 */

/**
 * Значение ячейки: всё, что представимо как JSON (см. `pg.ts`). Форма
 * совпадает со схемой результата команды (`z.json()`), поэтому вложенные
 * структуры здесь без `readonly`: иначе два одинаковых по смыслу типа не
 * были бы совместимы.
 */
export type SqlValue =
  | string
  | number
  | boolean
  | null
  | SqlValue[]
  | { [key: string]: SqlValue };

/** Результат первого оператора: набор строк либо его отсутствие. */
export type SqlOutcome =
  | {
    readonly kind: "rows";
    readonly columns: readonly string[];
    readonly rows: readonly (readonly SqlValue[])[];
    /**
     * Типы колонок (OID) в порядке `columns`; их сообщает сервер вместе
     * с именами. Печати они не нужны и она их не смотрит — нужны тому,
     * кто переносит значения в другую таблицу: по одному лишь значению
     * JS массив `text[]` не отличить от массива в `json` (`src/copy/`).
     */
    readonly oids?: readonly number[];
  }
  | {
    readonly kind: "done";
    /** Затронутые строки, как их сообщает сервер; `SET` — `-1`. */
    readonly rowcount: number;
  };

/** Форма вывода: умолчание и два флага команды. */
export type OutputFormat = "table" | "json" | "md";

/** Текст результата для stdout; всегда завершается переводом строки. */
export function renderOutcome(
  outcome: SqlOutcome,
  format: OutputFormat,
): string {
  if (outcome.kind === "done") {
    // `--md` собственной формы для «без набора строк» не имеет: markdown
    // нужен таблице, а её здесь нет (спека называет форму только для
    // умолчания и `--json`).
    return format === "json"
      ? `{"ok": true, "rowcount": ${outcome.rowcount}}\n`
      : `OK (rowcount=${outcome.rowcount})\n`;
  }
  switch (format) {
    case "table":
      return table(outcome.columns, outcome.rows);
    case "json":
      return json(outcome.columns, outcome.rows);
    case "md":
      return markdown(outcome.columns, outcome.rows);
    default: {
      const unknown: never = format;
      throw new TypeError(`неизвестная форма вывода: ${String(unknown)}`);
    }
  }
}

/**
 * ASCII-таблица: колонки через два пробела, каждая добита пробелами
 * справа — включая последнюю в строке (спека, поэтому у эталонов значимы
 * хвостовые пробелы). Ноль строк — шапка и счётчик, без разделителя.
 */
function table(
  columns: readonly string[],
  rows: readonly (readonly SqlValue[])[],
): string {
  const cells = rows.map((row) => columns.map((_, i) => textOf(row[i])));
  // Ширина — обходом, а не раскрытием массива в аргументы `Math.max`:
  // у движка предел на число аргументов (около 125 тысяч), а выборка
  // ad-hoc запроса бывает и больше — раскрытие роняло бы её RangeError'ом.
  const widths = columns.map((name, i) =>
    cells.reduce((max, row) => Math.max(max, width(row[i])), width(name))
  );
  const line = (values: readonly string[]) =>
    `${values.map((value, i) => pad(value, widths[i])).join("  ")}\n`;
  const header = line(columns);
  if (rows.length === 0) return `${header}(0 rows)\n`;
  const ruler = `${widths.map((size) => "-".repeat(size)).join("  ")}\n`;
  // Счётчик печатается при любом числе строк, включая одну: «(1 rows)» —
  // форма оригинала, и эталон снят на ней.
  return header + ruler + cells.map(line).join("") + `(${rows.length} rows)\n`;
}

/** Одна строка: массив объектов «колонка → значение». */
function json(
  columns: readonly string[],
  rows: readonly (readonly SqlValue[])[],
): string {
  // Объект собирается из колонок, а не из готовой записи: у записи
  // ключ-число ушёл бы в начало по правилам порядка ключей JS, а порядок
  // колонок задаёт сервер.
  const items = rows.map((row) =>
    `{${
      columns
        .map((name, i) => `${JSON.stringify(name)}: ${jsonValue(row[i])}`)
        .join(", ")
    }}`
  );
  return `[${items.join(", ")}]\n`;
}

/** Markdown-таблица; 0 строк — шапка и разделитель. */
function markdown(
  columns: readonly string[],
  rows: readonly (readonly SqlValue[])[],
): string {
  const line = (values: readonly string[]) => `| ${values.join(" | ")} |\n`;
  return line(columns) +
    line(columns.map(() => "---")) +
    rows.map((row) => line(columns.map((_, i) => escape(textOf(row[i])))))
      .join("");
}

/**
 * Текстовая форма значения: NULL — пустая строка (никогда `None`), всё
 * без собственной текстовой формы — своим JSON.
 */
function textOf(value: SqlValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return jsonValue(value);
  return String(value);
}

/**
 * JSON значения с разделителями оригинала (`, ` и `: `) и без
 * экранирования не-ASCII: форма выдачи — контракт, а `JSON.stringify`
 * печатает вложенное компактно.
 */
function jsonValue(value: SqlValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonValue).join(", ")}]`;
  return `{${
    Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${jsonValue(item)}`)
      .join(", ")
  }}`;
}

/** Экранирование ячейки markdown: спецсимволы разметки и перевод строки. */
function escape(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

/**
 * Ширина в кодовых точках, а не в единицах UTF-16: суррогатная пара —
 * один символ на экране, и добивка по `length` разъехалась бы.
 */
function width(text: string): number {
  return [...text].length;
}

function pad(text: string, size: number): string {
  return text + " ".repeat(Math.max(0, size - width(text)));
}
