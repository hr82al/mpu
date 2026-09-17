/**
 * Компиляция мини-языка в запросы Sheets API (`docs/specs/sheet-batch.md`,
 * таблица «Инструкции записи → запрос»).
 *
 * Таблица глаголов — данные: имя → сборщик запроса. Логики между
 * инструкциями нет и быть не должно — порядок запросов равен порядку
 * инструкций, и каждая компилируется независимо от соседей. Отсюда же
 * граница, которую видно только здесь: лист, создаваемый этим же
 * скриптом, на компиляции не существует — имена резолвятся по
 * состоянию таблицы, снятому до компиляции.
 */

import { UsageError } from "../command/mod.ts";
import { cellValue, color, condition, number, styleOf } from "./format.ts";
import { columnNumber } from "./a1.ts";
import {
  type DimensionRange,
  dimensionRange,
  type GridRange,
  gridRange,
  sheetOf,
  type SheetRef,
} from "./grid.ts";
import { type Instruction, splitScript, tokenize, unquote } from "./script.ts";

/** Что известно компилятору сверх самого скрипта. */
export interface CompileContext {
  /** Листы таблицы на момент компиляции. */
  readonly sheets: readonly SheetRef[];
  /** Лист по умолчанию (`-n`); не задан — диапазон обязан назвать свой. */
  readonly defaultSheet?: string;
  /** `-l/--literal`: значение всегда строка. */
  readonly literal?: boolean;
}

/** Итог компиляции: запросы и листы, которых они касаются. */
export interface Compiled {
  readonly requests: readonly unknown[];
  /** sheetId затронутых листов — для инвалидации кэша после записи. */
  readonly sheetIds: readonly number[];
}

/** Аргументы сборщика: токены после глагола и хвост текста. */
interface Args {
  readonly tokens: readonly string[];
  /** Текст инструкции после глагола, без токенизации. */
  readonly rest: string;
  readonly ctx: CompileContext;
}

/** Сборщик одной инструкции: токены → запросы (обычно один). */
type Verb = (args: Args) => readonly unknown[];

/**
 * Компилирует скрипт целиком. Отказ любой инструкции называет её номер:
 * оператор правит скрипт, а не гадает, какая из тридцати строк не та.
 */
export function compileScript(
  source: string,
  ctx: CompileContext,
): Compiled {
  const requests: unknown[] = [];
  for (const instruction of splitScript(source)) {
    for (const request of compileOne(instruction, ctx)) requests.push(request);
  }
  return { requests, sheetIds: touchedSheets(requests) };
}

/** Одна инструкция; ошибка получает префикс со своим номером. */
function compileOne(
  instruction: Instruction,
  ctx: CompileContext,
): readonly unknown[] {
  try {
    return dispatch(instruction.text, ctx);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    throw new UsageError(`строка ${instruction.line}: ${err.message}`, {
      cause: err,
    });
  }
}

function dispatch(text: string, ctx: CompileContext): readonly unknown[] {
  if (text.startsWith("py{") || text.startsWith("py {")) {
    throw new UsageError(
      "py{…} не поддерживается; собери инструкции сами и передай " +
        "готовым скриптом",
    );
  }
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  if (tokens[0].startsWith("@")) {
    const body = jsonBlock(tailAfter(text, tokens, 1));
    return [{ [tokens[0].slice(1)]: sugared(body, ctx) }];
  }
  const pair = tokens.length > 1 ? `${tokens[0]} ${tokens[1]}` : undefined;
  const verb = pair !== undefined && VERBS[pair] !== undefined
    ? pair
    : tokens[0];
  const handler = VERBS[verb];
  if (handler === undefined) {
    // У двухсловных семейств называется пара целиком: `неизвестный
    // глагол 'cols'` не подсказывает, что не так со вторым словом
    // (`sheet-batch.md`, отклонение fix).
    const named = PAIRS.has(tokens[0]) && pair !== undefined ? pair : tokens[0];
    throw new UsageError(`неизвестный глагол '${named}'`);
  }
  const used = verb.includes(" ") ? 2 : 1;
  return handler({
    tokens: tokens.slice(used),
    rest: tailAfter(text, tokens, used),
    ctx,
  });
}

/** Текст инструкции после первых `used` токенов — дословно. */
function tailAfter(
  text: string,
  tokens: readonly string[],
  used: number,
): string {
  let index = 0;
  for (let taken = 0; taken < used; taken++) {
    index = text.indexOf(tokens[taken], index) + tokens[taken].length;
  }
  return text.slice(index).trim();
}

/** sheetId всех запросов: их листы обновились и кэш по ним протух. */
function touchedSheets(requests: readonly unknown[]): readonly number[] {
  const found = new Set<number>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "sheetId" && typeof item === "number") found.add(item);
      else walk(item);
    }
  };
  walk(requests);
  return [...found].sort((a, b) => a - b);
}

/** Текст после первого вхождения токена — для дословных хвостов. */
function after(text: string, token: string): string {
  const at = text.indexOf(token);
  return at === -1 ? "" : text.slice(at + token.length).trim();
}

/** Обязательный токен по позиции; его отсутствие — ошибка компиляции. */
function need(
  tokens: readonly string[],
  index: number,
  what: string,
): string {
  const token = tokens[index];
  if (token === undefined) throw new UsageError(`нужен ${what}`);
  return token;
}

/** Диапазон по токену с учётом листа-умолчания. */
function rangeOf(args: Args, token: string): GridRange {
  return gridRange(token, args.ctx.sheets, args.ctx.defaultSheet);
}

/** Полоса по токену; размерность приходит от глагола. */
function dimOf(
  args: Args,
  token: string,
  dimension: "ROWS" | "COLUMNS",
): DimensionRange {
  return dimensionRange(
    token,
    dimension,
    args.ctx.sheets,
    args.ctx.defaultSheet,
  );
}

/** Лист по токену: имя как есть либо `'Имя'` в кавычках. */
function sheetByToken(args: Args, token: string): SheetRef {
  return sheetOf(args.ctx.sheets, unquote(token));
}

/** Верхне-левая ячейка диапазона: открытая граница значит 0. */
function startOf(range: GridRange): Readonly<Record<string, unknown>> {
  return {
    sheetId: range.sheetId,
    rowIndex: range.startRowIndex ?? 0,
    columnIndex: range.startColumnIndex ?? 0,
  };
}

/** Значение ключевого слова-опции: `k=v` → v; иначе `undefined`. */
function keyValue(token: string, key: string): string | undefined {
  return token.startsWith(`${key}=`) ? token.slice(key.length + 1) : undefined;
}

/** Слово-опция вне списка — ошибка, а не молчаливое игнорирование. */
function rejectUnknown(token: string): never {
  throw new UsageError(`неизвестная опция '${token}'`);
}

/** Одна ячейка с полями: общий каркас `set`, `label` и `note`. */
function cellRequest(
  range: GridRange,
  cell: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): unknown {
  return {
    updateCells: {
      rows: [{ values: [cell] }],
      fields: fields.join(","),
      start: startOf(range),
    },
  };
}

/**
 * Тело generic-инструкции: весь текст после глагола, разобранный как
 * JSON. Именно текст, а не токен: `@kind [1,2]` обязано доехать до
 * проверки «это не объект», а не отбиться раньше как «не блок» — иначе
 * у отказа спеки не осталось бы пути, которым он достижим.
 */
function jsonBlock(text: string): Readonly<Record<string, unknown>> {
  if (text === "") throw new UsageError("нужен JSON-блок");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : "";
    throw new UsageError(`плохой JSON: ${reason}`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("ожидался JSON-объект");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * Сахар generic-инструкции: строка `@RANGE` разворачивается в
 * GridRange, `"@'Лист'"` — в id листа, а ключ, оканчивающийся на
 * `Color`, со строкой `#…` — в цвет. Правило одно на весь объект,
 * включая вложенные: иначе оператору пришлось бы помнить, в каких
 * ключах сахар работает, а в каких нет.
 */
function sugared(value: unknown, ctx: CompileContext, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sugared(item, ctx, key));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      out[name] = sugared(item, ctx, name);
    }
    return out;
  }
  if (typeof value !== "string") return value;
  if (key.endsWith("Color") && value.startsWith("#")) return color(value);
  if (!value.startsWith("@")) return value;
  const token = value.slice(1);
  if (key === "sheetId") {
    return sheetOf(ctx.sheets, unquote(token)).sheetId;
  }
  return gridRange(token, ctx.sheets, ctx.defaultSheet);
}

const SIMPLE_VERBS: Readonly<Record<string, Verb>> = {
  // Дословно: `raw` затем и нужен, что сахар иногда мешает — форма
  // запроса Sheets API шире того, что язык умеет описать.
  raw: (args) => [jsonBlock(args.rest)],

  set: (args) => {
    const token = need(args.tokens, 0, "RANGE");
    const range = rangeOf(args, token);
    const tail = after(args.rest, token);
    // Хвост после первого `=` уходит дословно: формула содержит и
    // пробелы, и `;`, и токенизировать её нечем.
    const value = tail.startsWith("=")
      ? cellValue(tail.slice(1).trim(), args.ctx.literal)
      : cellValue(need(args.tokens, 1, "ЗНАЧЕНИЕ"), args.ctx.literal);
    return [cellRequest(range, { userEnteredValue: value }, [
      "userEnteredValue",
    ])];
  },

  label: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    const text = unquote(need(args.tokens, 1, "ТЕКСТ"));
    const style = styleOf(args.tokens.slice(2));
    const cell: Record<string, unknown> = {
      userEnteredValue: { stringValue: text },
    };
    if (style.fields.length > 0) cell.userEnteredFormat = style.format;
    return [cellRequest(range, cell, ["userEnteredValue", ...style.fields])];
  },

  note: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    const text = unquote(need(args.tokens, 1, "ТЕКСТ"));
    return [cellRequest(range, { note: text }, ["note"])];
  },

  style: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    const style = styleOf(args.tokens.slice(1));
    if (style.fields.length === 0) {
      throw new UsageError("нужен хотя бы один стиль-флаг");
    }
    return [{
      repeatCell: {
        range,
        cell: { userEnteredFormat: style.format },
        fields: style.fields.join(","),
      },
    }];
  },

  clear: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    const what = args.tokens[1] ?? "values";
    const fields = what === "values"
      ? "userEnteredValue"
      : what === "formats"
      ? "userEnteredFormat"
      : what === "all"
      ? "userEnteredValue,userEnteredFormat,note"
      : rejectUnknown(what);
    return [{ updateCells: { range, fields } }];
  },

  merge: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    const how = args.tokens[1] ?? "all";
    const mergeType = how === "all"
      ? "MERGE_ALL"
      : how === "rows"
      ? "MERGE_ROWS"
      : how === "cols"
      ? "MERGE_COLUMNS"
      : rejectUnknown(how);
    return [{ mergeCells: { range, mergeType } }];
  },

  unmerge: (args) => [{
    unmergeCells: { range: rangeOf(args, need(args.tokens, 0, "RANGE")) },
  }],

  border: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    let sides: string | undefined;
    let style = "SOLID";
    let paint = color("#000000");
    for (const token of args.tokens.slice(1)) {
      const styleValue = keyValue(token, "style");
      const colorValue = keyValue(token, "color");
      if (styleValue !== undefined) style = styleValue.toUpperCase();
      else if (colorValue !== undefined) paint = color(colorValue);
      else if (SIDES[token] === undefined) rejectUnknown(token);
      // Две стороны в одной инструкции — не «побеждает последняя»:
      // первая исчезла бы бесследно, а рамку рисуют не наугад.
      else if (sides !== undefined) {
        throw new UsageError(`сторона названа дважды: '${sides}' и '${token}'`);
      } else sides = token;
    }
    const border = { style, color: paint };
    const out: Record<string, unknown> = { range };
    for (const side of SIDES[sides ?? "all"]) out[side] = border;
    return [{ updateBorders: out }];
  },

  sort: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    let by: string | undefined;
    for (const token of args.tokens.slice(1)) {
      const value = keyValue(token, "by");
      if (value === undefined) rejectUnknown(token);
      by = value;
    }
    if (by === undefined) throw new UsageError("нужен by=COL[:desc][,…]");
    const sortSpecs = by.split(",").map((item) => {
      const [column, order] = item.split(":");
      return {
        dimensionIndex: columnIndexOf(column),
        sortOrder: order === "desc" ? "DESCENDING" : "ASCENDING",
      };
    });
    return [{ sortRange: { range, sortSpecs } }];
  },

  dedupe: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    let cols: string | undefined;
    for (const token of args.tokens.slice(1)) {
      const value = keyValue(token, "cols");
      if (value === undefined) rejectUnknown(token);
      cols = value;
    }
    const out: Record<string, unknown> = { range };
    if (cols !== undefined) {
      out.comparisonColumns = cols.split(",").map((column) => ({
        sheetId: range.sheetId,
        dimension: "COLUMNS",
        startIndex: columnIndexOf(column),
        endIndex: columnIndexOf(column) + 1,
      }));
    }
    return [{ deleteDuplicates: out }];
  },

  trim: (args) => [{
    trimWhitespace: { range: rangeOf(args, need(args.tokens, 0, "RANGE")) },
  }],

  validate: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    const rule: Record<string, unknown> = {
      condition: condition(need(args.tokens, 1, "УСЛОВИЕ")),
    };
    for (const token of args.tokens.slice(2)) {
      const message = keyValue(token, "msg");
      if (token === "strict") rule.strict = true;
      else if (token === "showdrop") rule.showCustomUi = true;
      else if (message !== undefined) rule.inputMessage = unquote(message);
      else rejectUnknown(token);
    }
    return [{ setDataValidation: { range, rule } }];
  },

  protect: (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    const protectedRange: Record<string, unknown> = { range };
    for (const token of args.tokens.slice(1)) {
      const editors = keyValue(token, "editors");
      const desc = keyValue(token, "desc");
      if (token === "warn") protectedRange.warningOnly = true;
      else if (desc !== undefined) protectedRange.description = unquote(desc);
      else if (editors !== undefined) {
        // Список пользователей — всегда массив, даже из одного адреса:
        // скаляр Sheets API молча не принимает.
        protectedRange.editors = { users: unquote(editors).split(",") };
      } else rejectUnknown(token);
    }
    return [{ addProtectedRange: { protectedRange } }];
  },

  unprotect: (args) => {
    const id = keyValue(need(args.tokens, 0, "id=N"), "id");
    if (id === undefined) throw new UsageError("нужен id=N");
    return [{
      deleteProtectedRange: {
        protectedRangeId: number(`id=${id}`, id),
      },
    }];
  },

  autofill: (args) => {
    const target = arrow(args, "СПАН -> DEST");
    return [{
      autoFill: {
        range: rangeOf(args, target.dest),
        useAlternateSeries: false,
      },
    }];
  },

  copy: (args) => {
    const target = arrow(args, "SRC -> DEST");
    let pasteType = "PASTE_NORMAL";
    for (const token of target.tail) {
      const type = keyValue(token, "type");
      if (type === undefined) rejectUnknown(token);
      pasteType = `PASTE_${type.toUpperCase()}`;
    }
    return [{
      copyPaste: {
        source: rangeOf(args, target.src),
        destination: rangeOf(args, target.dest),
        pasteType,
      },
    }];
  },

  cut: (args) => {
    const target = arrow(args, "SRC -> DEST");
    for (const token of target.tail) rejectUnknown(token);
    return [{
      cutPaste: {
        source: rangeOf(args, target.src),
        destination: rangeOf(args, target.dest),
      },
    }];
  },

  "find-replace": (args) => {
    const raw = unquote(need(args.tokens, 0, "НАЙТИ"));
    // Шаблон в слэшах — регэксп сам по себе, слова `regex` для этого не
    // нужно; слэши при этом снимаются, они разделители, а не часть
    // шаблона.
    const slashed = raw.length > 1 && raw.startsWith("/") && raw.endsWith("/");
    const out: Record<string, unknown> = {
      find: slashed ? raw.slice(1, -1) : raw,
      replacement: unquote(need(args.tokens, 1, "ЗАМЕНА")),
    };
    let regex = slashed;
    let scope: string | undefined;
    let allSheets = false;
    let includeFormulas = false;
    for (const token of args.tokens.slice(2)) {
      if (token === "regex") regex = true;
      else if (token === "case") out.matchCase = true;
      else if (token === "formulas") includeFormulas = true;
      else if (token === "allsheets") allSheets = true;
      else if (token.includes("!")) scope = token;
      else rejectUnknown(token);
    }
    out.searchByRegex = regex;
    if (includeFormulas) out.includeFormulas = true;
    if (allSheets) out.allSheets = true;
    else if (scope !== undefined) out.range = rangeOf(args, scope);
    else if (args.ctx.defaultSheet !== undefined) {
      out.sheetId = sheetOf(args.ctx.sheets, args.ctx.defaultSheet).sheetId;
    } else {
      throw new UsageError("нет области — задай -n, allsheets или 'Лист'!span");
    }
    return [{ findReplace: out }];
  },
};

/** Стороны рамки: имя опции → перечень сторон запроса. */
const SIDES: Readonly<Record<string, readonly string[]>> = {
  all: ["top", "bottom", "left", "right", "innerHorizontal", "innerVertical"],
  around: ["top", "bottom", "left", "right"],
  inner: ["innerHorizontal", "innerVertical"],
  top: ["top"],
  bottom: ["bottom"],
  left: ["left"],
  right: ["right"],
};

/** Индекс столбца из буквы либо номера: `A` → 0, `3` → 2. */
function columnIndexOf(text: string): number {
  if (/^\d+$/.test(text)) return Number(text) - 1;
  if (!/^[A-Za-z]{1,3}$/.test(text)) {
    throw new UsageError(`плохой столбец '${text}'`);
  }
  // Перевод букв в номер один на весь модуль (`a1.ts`): вторая копия
  // разошлась бы с первой на первой же правке.
  return columnNumber(text) - 1;
}

/** Форма `SRC -> DEST [хвост]`: без стрелки инструкция бессмысленна. */
function arrow(
  args: Args,
  what: string,
): {
  readonly src: string;
  readonly dest: string;
  readonly tail: readonly string[];
} {
  const at = args.tokens.indexOf("->");
  if (at === -1 || at === 0 || args.tokens[at + 1] === undefined) {
    throw new UsageError(`нужен ${what}`);
  }
  return {
    src: args.tokens[0],
    dest: args.tokens[at + 1],
    tail: args.tokens.slice(at + 2),
  };
}

/**
 * Инструкции над полосами. Тело у `cols` и `rows` одно, различается
 * только размерность, поэтому таблица порождается, а не переписывается
 * дважды: две копии разошлись бы на первой же правке.
 */
function dimensionVerbs(
  word: string,
  dimension: "ROWS" | "COLUMNS",
): Readonly<Record<string, Verb>> {
  const range = (args: Args) =>
    dimOf(args, need(args.tokens, 0, "DIM"), dimension);
  return {
    [`${word} insert`]: (args) => {
      const base = range(args);
      const start = base.startIndex;
      let end = base.endIndex;
      let inherit = true;
      for (const token of args.tokens.slice(1)) {
        const count = /^\+(\d+)$/.exec(token);
        if (count !== null) end = start + Number(count[1]);
        else if (token === "inherit" || token === "inherit=before") {
          inherit = true;
        } else if (token === "inherit=after") inherit = false;
        else rejectUnknown(token);
      }
      return [{
        insertDimension: {
          range: { ...base, startIndex: start, endIndex: end },
          // На левом (верхнем) краю наследовать нечего, и Google
          // отвечает отказом «range.startIndex must not be 0 if
          // inheritFromBefore is true» — падает вся пачка, а не одна
          // инструкция. Поэтому на нулевом индексе признак ложен при
          // любом вводе (`sheet-batch.md`, отклонение fix).
          inheritFromBefore: start === 0 ? false : inherit,
        },
      }];
    },
    [`${word} delete`]: (args) => [{ deleteDimension: { range: range(args) } }],
    [`${word} move`]: (args) => {
      const at = args.tokens.indexOf("after");
      const target = args.tokens[at + 1];
      if (at === -1 || target === undefined) {
        throw new UsageError("нужен after ИНДЕКС");
      }
      return [{
        moveDimension: {
          source: range(args),
          destinationIndex: number(`after ${target}`, target),
        },
      }];
    },
    [`${word} autosize`]: (args) => [{
      autoResizeDimensions: { dimensions: range(args) },
    }],
    [`${word} resize`]: (args) => {
      let px: string | undefined;
      for (const token of args.tokens.slice(1)) {
        const value = keyValue(token, "px");
        if (value === undefined) rejectUnknown(token);
        px = value;
      }
      if (px === undefined) throw new UsageError("нужен px=N");
      return [{
        updateDimensionProperties: {
          range: range(args),
          properties: { pixelSize: number(`px=${px}`, px) },
          fields: "pixelSize",
        },
      }];
    },
    [`${word} hide`]: (args) => [hiddenRequest(range(args), true)],
    [`${word} show`]: (args) => [hiddenRequest(range(args), false)],
    [`group ${word}`]: (args) => [{
      addDimensionGroup: { range: range(args) },
    }],
    [`ungroup ${word}`]: (args) => [{
      deleteDimensionGroup: { range: range(args) },
    }],
    [`append ${word}`]: (args) => {
      const count = need(args.tokens, 0, "количество");
      let title = args.ctx.defaultSheet;
      const at = args.tokens.indexOf("on");
      if (at !== -1) title = unquote(need(args.tokens, at + 1, "ЛИСТ"));
      if (title === undefined) {
        throw new UsageError("нужен лист: on ЛИСТ или -n");
      }
      return [{
        appendDimension: {
          sheetId: sheetOf(args.ctx.sheets, title).sheetId,
          dimension,
          length: number(count, count),
        },
      }];
    },
  };
}

function hiddenRequest(range: DimensionRange, hidden: boolean): unknown {
  return {
    updateDimensionProperties: {
      range,
      properties: { hiddenByUser: hidden },
      fields: "hiddenByUser",
    },
  };
}

/** Инструкции над листом и таблицей целиком. */
const SHEET_VERBS: Readonly<Record<string, Verb>> = {
  freeze: (args) => {
    // Лист — первый токен, не начатый `rows=`/`cols=`, и только он:
    // второй бесключевой токен раньше молча затирал первый.
    const named = args.tokens[0] !== undefined &&
      keyValue(args.tokens[0], "rows") === undefined &&
      keyValue(args.tokens[0], "cols") === undefined;
    const title = named ? unquote(args.tokens[0]) : args.ctx.defaultSheet;
    const grid: Record<string, unknown> = {};
    const fields: string[] = [];
    for (const token of args.tokens.slice(named ? 1 : 0)) {
      const rows = keyValue(token, "rows");
      const cols = keyValue(token, "cols");
      if (rows !== undefined) {
        grid.frozenRowCount = number(token, rows);
        fields.push("gridProperties.frozenRowCount");
      } else if (cols !== undefined) {
        grid.frozenColumnCount = number(token, cols);
        fields.push("gridProperties.frozenColumnCount");
      } else rejectUnknown(token);
    }
    if (title === undefined) {
      throw new UsageError("нужен лист: freeze ЛИСТ или -n");
    }
    if (fields.length === 0) throw new UsageError("нужен rows=N и/или cols=M");
    return [{
      updateSheetProperties: {
        properties: {
          sheetId: sheetOf(args.ctx.sheets, title).sheetId,
          gridProperties: grid,
        },
        fields: fields.join(","),
      },
    }];
  },

  "sheet add": (args) => {
    const properties: Record<string, unknown> = {
      title: unquote(need(args.tokens, 0, "ИМЯ")),
    };
    let rows = 1000;
    let cols = 26;
    let index: number | undefined;
    for (const token of args.tokens.slice(1)) {
      const rowsValue = keyValue(token, "rows");
      const colsValue = keyValue(token, "cols");
      const indexValue = keyValue(token, "index");
      if (rowsValue !== undefined) rows = number(token, rowsValue);
      else if (colsValue !== undefined) cols = number(token, colsValue);
      else if (indexValue !== undefined) index = number(token, indexValue);
      else rejectUnknown(token);
    }
    // Порядок ключей фиксирован формой запроса, а не порядком флагов:
    // `index` стоит перед сеткой независимо от того, как его написали.
    if (index !== undefined) properties.index = index;
    properties.gridProperties = { rowCount: rows, columnCount: cols };
    return [{ addSheet: { properties } }];
  },

  "sheet delete": (args) => [{
    deleteSheet: {
      sheetId: sheetByToken(args, need(args.tokens, 0, "ЛИСТ")).sheetId,
    },
  }],

  "sheet rename": (args) => [{
    updateSheetProperties: {
      properties: {
        sheetId: sheetByToken(args, need(args.tokens, 0, "СТАРОЕ")).sheetId,
        title: unquote(need(args.tokens, 1, "НОВОЕ")),
      },
      fields: "title",
    },
  }],

  "sheet dup": (args) => {
    const source = sheetByToken(args, need(args.tokens, 0, "ЛИСТ"));
    const at = args.tokens.indexOf("as");
    const out: Record<string, unknown> = { sourceSheetId: source.sheetId };
    if (at !== -1) out.newSheetName = unquote(need(args.tokens, at + 1, "ИМЯ"));
    return [{ duplicateSheet: out }];
  },

  "sheet tab": (args) => {
    const sheet = sheetByToken(args, need(args.tokens, 0, "ЛИСТ"));
    const value = keyValue(need(args.tokens, 1, "color=#hex"), "color");
    if (value === undefined) throw new UsageError("нужен color=#hex");
    return [{
      updateSheetProperties: {
        properties: { sheetId: sheet.sheetId, tabColor: color(value) },
        fields: "tabColor",
      },
    }];
  },

  "cond add": (args) => {
    const range = rangeOf(args, need(args.tokens, 0, "RANGE"));
    const rule = condition(need(args.tokens, 1, "УСЛОВИЕ"));
    const style = styleOf(args.tokens.slice(2));
    // Без стиль-флагов правило всё равно должно что-то красить: жёлтый
    // фон — умолчание рабочей версии.
    const format = style.fields.length === 0
      ? { backgroundColor: color("#ffeb3b") }
      : style.format;
    return [{
      addConditionalFormatRule: {
        rule: { ranges: [range], booleanRule: { condition: rule, format } },
        index: 0,
      },
    }];
  },

  "cond clear": (args) => {
    const sheet = sheetByToken(args, need(args.tokens, 0, "ЛИСТ"));
    let index = 0;
    for (const token of args.tokens.slice(1)) {
      const value = keyValue(token, "index");
      if (value === undefined) rejectUnknown(token);
      index = number(token, value);
    }
    return [{ deleteConditionalFormatRule: { sheetId: sheet.sheetId, index } }];
  },

  "name add": (args) => [{
    addNamedRange: {
      namedRange: {
        name: unquote(need(args.tokens, 0, "ИМЯ")),
        range: rangeOf(args, need(args.tokens, 1, "RANGE")),
      },
    },
  }],

  "name del": (args) => {
    const value = keyValue(need(args.tokens, 0, "id=ID"), "id");
    if (value === undefined) throw new UsageError("нужен id=ID");
    return [{ deleteNamedRange: { namedRangeId: unquote(value) } }];
  },
};

/**
 * Первые слова двухсловных глаголов — из таблицы, а не списком руками:
 * при опечатке во втором слове ошибка обязана называть пару целиком
 * (`sheet-batch.md`, отклонение fix), и список, писанный отдельно,
 * разошёлся бы с таблицей на первом же новом семействе.
 */
/** Все глаголы языка записи одной таблицей. */
const VERBS: Readonly<Record<string, Verb>> = {
  ...SIMPLE_VERBS,
  ...SHEET_VERBS,
  ...dimensionVerbs("cols", "COLUMNS"),
  ...dimensionVerbs("rows", "ROWS"),
};

const PAIRS = new Set(
  Object.keys(VERBS)
    .filter((verb) => verb.includes(" "))
    .map((verb) => verb.slice(0, verb.indexOf(" "))),
);
