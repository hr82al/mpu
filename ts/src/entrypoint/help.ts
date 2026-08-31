/**
 * Рендер справки: индекс уровня собирается из реестра автоматически (не
 * дублируется руками и потому не устаревает), листовая справка — из
 * объявления команды. Структура — по CLAUDE.md: промежуточный уровень
 * краток, листовой полон.
 */

import type { Command, InputSpec, SchemaField } from "../command/mod.ts";

/** Строка индекса: имя сегмента и его однострока. */
export interface IndexEntry {
  readonly name: string;
  readonly summary: string;
}

/** Ширина строки справки: описания переносятся по этой границе. */
const WIDTH = 78;

/**
 * Индекс уровня: однострока и список того, что доступно ниже. `notes` —
 * хвост уровня: то, что нужно знать до выбора подкоманды, а не внутри
 * неё (у корня — какая переменная окружения какие файлы уводит). У
 * промежуточных уровней его нет.
 */
export function renderIndex(
  usage: string,
  summary: string,
  entries: readonly IndexEntry[],
  notes = "",
): string {
  const width = Math.max(0, ...entries.map((entry) => entry.name.length));
  const lines = entries.map(
    (entry) => `  ${entry.name.padEnd(width)}  ${entry.summary}\n`,
  );
  return `Использование: ${usage}\n\n${summary}\n\nПодкоманды:\n` +
    lines.join("") +
    notes +
    "\nПодробнее: --help у каждой подкоманды.\n";
}

/**
 * Листовая справка: usage, однострока, перечень входов и тело
 * объявления. Перечень входов собирается из схемы аргументов, а не
 * пишется в тексте: описание каждого входа уже объявлено там и уходит
 * агенту схемой тула — второй раз в тексте оно только расходилось бы
 * со схемой и съедало предел описания тула.
 */
export function renderCommandHelp(command: Command): string {
  return `Использование: ${command.usage}\n\n${command.summary}\n\n` +
    renderInputs(command) +
    `${command.help}\n`;
}

/**
 * Справка поверхности точки входа: ни схемы аргументов, ни результата
 * у неё нет, поэтому рендерить нечего, кроме строки использования и
 * однострокѝ. Формат тот же, что у листовой команды: читателю не
 * должно быть видно, чем они отличаются внутри.
 */
export function renderSurfaceHelp(usage: string, summary: string): string {
  return `Использование: ${usage}\n\n${summary}\n`;
}

/** Секции «Аргументы» и «Флаги»; входов нет — пустая строка. */
function renderInputs(command: Command): string {
  const required = new Set(command.requiredInputNames);
  const rows = command.inputs.map((input) => ({
    input,
    label: labelOf(input, command.argsJsonSchema.properties[input.name]),
    text: textOf(
      command.argsJsonSchema.properties[input.name],
      required.has(input.name),
    ),
  }));
  const width = Math.max(0, ...rows.map((row) => row.label.length));
  const positional = rows.filter((row) => row.input.form.positional);
  const flags = rows.filter((row) => row.input.form.positional === undefined);
  return section("Аргументы", positional, width) +
    section("Флаги", flags, width);
}

interface HelpRow {
  readonly label: string;
  readonly text: string;
}

function section(
  title: string,
  rows: readonly HelpRow[],
  width: number,
): string {
  if (rows.length === 0) return "";
  const lines = rows.map((row) => wrap(row.label.padEnd(width), row.text));
  return `${title}:\n${lines.join("")}\n`;
}

/**
 * Левая колонка строки: формы записи входа и место значения.
 * `NAME...` — позиционный вход, забирающий остаток argv.
 */
function labelOf(input: InputSpec, field: SchemaField): string {
  const value = valueOf(input, field);
  if (input.form.positional !== undefined) {
    const name = input.name.toUpperCase();
    return input.form.positional === "rest" ? `${name}...` : name;
  }
  const long = `--${input.name}${value === "" ? "" : ` ${value}`}`;
  return input.form.short === undefined
    ? `    ${long}`
    : `-${input.form.short}, ${long}`;
}

/** Место значения: перечисление, если оно ограничено, иначе имя входа. */
function valueOf(input: InputSpec, field: SchemaField): string {
  if (input.kind === "boolean") return "";
  const values = field.enum;
  if (values !== undefined) return values.map(String).join("|");
  return input.name.toUpperCase();
}

/** Правая колонка: описание входа плюс умолчание и обязательность. */
function textOf(field: SchemaField, required: boolean): string {
  const description = field.description ?? "";
  if (required) return `${description} (обязателен)`.trim();
  const value = field.default;
  if (value === undefined || value === false) return description;
  if (Array.isArray(value) && value.length === 0) return description;
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  return `${description} (по умолчанию: ${shown})`.trim();
}

/** Строка с переносом описания под колонку описаний. */
function wrap(label: string, text: string): string {
  const indent = " ".repeat(label.length + 4);
  const limit = WIDTH - indent.length;
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current === "") current = word;
    else if (`${current} ${word}`.length <= limit) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  const [first = "", ...rest] = lines;
  // trimEnd — на случай входа без описания: строка не должна кончаться
  // колонкой пробелов, это видно в diff'ах и в golden-эталонах.
  return `${`  ${label}  ${first}`.trimEnd()}\n` +
    rest.map((line) => `${indent}${line}\n`).join("");
}
