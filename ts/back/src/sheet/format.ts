/**
 * Значения, стиль-флаги, цвета и условия мини-языка
 * (`docs/specs/sheet-batch.md`, «Значения», «Условия»).
 *
 * Стиль собирается вместе с маской затронутых путей: Sheets API правит
 * ровно то, что перечислено в `fields`, и собрать одно без другого
 * нельзя — маска, разошедшаяся с телом, стирает соседний формат.
 */

import { UsageError } from "../command/mod.ts";
import { fraction } from "./emit.ts";
import { isQuoted, unquote } from "./script.ts";

/** Значение ячейки в форме Sheets API. */
export type CellValue = Readonly<Record<string, unknown>>;

/**
 * Значение из токена. Кавычки делают строкой что угодно; иначе
 * `true`/`false` — булево, число — число, `=…` — формула.
 * `literal` (`-l`) отменяет всё это: значение всегда строка.
 */
export function cellValue(token: string, literal = false): CellValue {
  if (isQuoted(token)) return { stringValue: unquote(token) };
  if (literal) return { stringValue: token };
  const lower = token.toLowerCase();
  if (lower === "true" || lower === "false") {
    return { boolValue: lower === "true" };
  }
  if (token.trim() !== "" && Number.isFinite(Number(token))) {
    return { numberValue: Number(token) };
  }
  if (token.startsWith("=")) return { formulaValue: token };
  return { stringValue: token };
}

/** Цвет в долях 0..1; альфа — только если названа. */
export function color(text: string): Readonly<Record<string, unknown>> {
  const hex = text.startsWith("#") ? text.slice(1) : "";
  if (!/^[0-9a-fA-F]+$/.test(hex) || ![3, 6, 8].includes(hex.length)) {
    throw new UsageError(`плохой цвет: '${text}'`);
  }
  const pairs = hex.length === 3
    ? [...hex].map((ch) => ch + ch)
    : hex.match(/../g) ?? [];
  const parts = pairs.map((pair) => parseInt(pair, 16) / 255);
  // `#AARRGGBB`: альфа впереди, как её пишет оператор, но в теле
  // запроса она последняя — порядок ключей поэтому фиксированный.
  const alpha = parts.length === 4 ? parts[0] : undefined;
  const [red, green, blue] = parts.length === 4 ? parts.slice(1) : parts;
  const out: Record<string, unknown> = {
    red: fraction(red),
    green: fraction(green),
    blue: fraction(blue),
  };
  if (alpha !== undefined) out.alpha = fraction(alpha);
  return out;
}

/** Собранный стиль: тело формата и маска затронутых путей. */
export interface Style {
  readonly format: Readonly<Record<string, unknown>>;
  readonly fields: readonly string[];
}

/** Словарные флаги: значение пути и сам путь внутри `userEnteredFormat`. */
const WORDS: Readonly<Record<string, readonly [readonly string[], unknown]>> = {
  bold: [["textFormat", "bold"], true],
  italic: [["textFormat", "italic"], true],
  strike: [["textFormat", "strikethrough"], true],
  underline: [["textFormat", "underline"], true],
  left: [["horizontalAlignment"], "LEFT"],
  center: [["horizontalAlignment"], "CENTER"],
  right: [["horizontalAlignment"], "RIGHT"],
  top: [["verticalAlignment"], "TOP"],
  middle: [["verticalAlignment"], "MIDDLE"],
  bottom: [["verticalAlignment"], "BOTTOM"],
  wrap: [["wrapStrategy"], "WRAP"],
  clip: [["wrapStrategy"], "CLIP"],
  overflow: [["wrapStrategy"], "OVERFLOW_CELL"],
};

/**
 * Стиль-флаги в порядке, в котором их написал оператор: и тело, и
 * маска идут этим порядком — голден фиксирует именно его.
 */
export function styleOf(tokens: readonly string[]): Style {
  const format: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const token of tokens) {
    const word = WORDS[token];
    if (word !== undefined) {
      put(format, fields, word[0], word[1]);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const value = eq === -1 ? "" : token.slice(eq + 1);
    switch (name) {
      case "bg":
        put(format, fields, ["backgroundColor"], color(value));
        break;
      case "fg":
        put(format, fields, ["textFormat", "foregroundColor"], color(value));
        break;
      case "size":
        put(format, fields, ["textFormat", "fontSize"], number(token, value));
        break;
      case "font":
        put(format, fields, ["textFormat", "fontFamily"], unquote(value));
        break;
      case "fmt":
        put(format, fields, ["numberFormat"], {
          type: numberFormatType(unquote(value)),
          pattern: unquote(value),
        });
        break;
      default:
        throw new UsageError(`неизвестный стиль-флаг '${token}'`);
    }
  }
  return { format, fields };
}

/** Тип числового формата по шаблону: процент, дата или число. */
function numberFormatType(pattern: string): string {
  if (pattern.includes("%")) return "PERCENT";
  return /[ymdYMD]/.test(pattern) ? "DATE" : "NUMBER";
}

/** Кладёт значение по пути и дописывает путь в маску без дублей. */
function put(
  format: Record<string, unknown>,
  fields: string[],
  path: readonly string[],
  value: unknown,
): void {
  let node = format;
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]] = value;
  const field = `userEnteredFormat.${path.join(".")}`;
  if (!fields.includes(field)) fields.push(field);
}

/** Число из значения ключевого флага; нечисловое — ошибка компиляции. */
export function number(token: string, value: string): number {
  if (!/^[+-]?\d+(\.\d+)?$/.test(value)) {
    throw new UsageError(`нечисловое значение в '${token}'`);
  }
  return Number(value);
}

/** Условие проверки данных и условного форматирования. */
export function condition(token: string): Readonly<Record<string, unknown>> {
  const numeric = /^num(>=|<=|!=|>|<|=)(.+)$/.exec(token);
  if (numeric !== null) {
    const types: Readonly<Record<string, string>> = {
      ">=": "NUMBER_GREATER_THAN_EQ",
      ">": "NUMBER_GREATER",
      "<=": "NUMBER_LESS_THAN_EQ",
      "<": "NUMBER_LESS",
      "=": "NUMBER_EQ",
      "!=": "NUMBER_NOT_EQ",
    };
    return typed(types[numeric[1]], [unquote(numeric[2])]);
  }
  if (token.startsWith("custom==")) {
    // Срезается `custom=`, а не `custom==`: формула обязана сохранить
    // ведущий `=`, иначе Sheets API не считает её формулой — и две
    // формы одного условия (`custom==Ф` и голое `=Ф`) дали бы разные
    // запросы.
    return typed("CUSTOM_FORMULA", [unquote(token.slice("custom=".length))]);
  }
  if (token.startsWith("=")) return typed("CUSTOM_FORMULA", [token]);
  if (token.startsWith("one-of=")) {
    // Значение с запятой внутри невыразимо — это записанное ограничение
    // языка, а не недосмотр разбора.
    return typed(
      "ONE_OF_LIST",
      unquote(token.slice("one-of=".length)).split(","),
    );
  }
  if (token.startsWith("text-contains=")) {
    return typed("TEXT_CONTAINS", [
      unquote(token.slice("text-contains=".length)),
    ]);
  }
  if (token.startsWith("text-eq=")) {
    return typed("TEXT_EQ", [unquote(token.slice("text-eq=".length))]);
  }
  if (token === "blank") return typed("BLANK", []);
  if (token === "not-blank") return typed("NOT_BLANK", []);
  if (token === "checkbox" || token === "bool") return typed("BOOLEAN", []);
  throw new UsageError(`непонятное условие '${token}'`);
}

function typed(
  type: string,
  values: readonly string[],
): Readonly<Record<string, unknown>> {
  if (values.length === 0) return { type };
  return {
    type,
    values: values.map((value) => ({ userEnteredValue: value })),
  };
}
