/**
 * Ввод команды `mpu sheet set` (`docs/specs/sheet-set.md`): выбор
 * режима по форме вызова и разбор трёх видов ввода в один список.
 *
 * Отдельно от команды, потому что весь этот разбор проверяется без
 * сети: негодный ввод обязан отбиваться до записи, а значит и до
 * единственного места, где нужен webapp.
 */

import { type CommandIo, readTextStdin, UsageError } from "../command/mod.ts";
import { fileText, type SheetIo } from "./sources.ts";

/** Как сервер должен понять значение. */
export type SetKind = "formula" | "value";

/** Одна запись: куда, чем и как понимать. */
export interface SetItem {
  readonly range: string;
  readonly kind: SetKind;
  readonly value: unknown;
}

/** Режим, выбранный формой вызова; в вывод не идёт, но нужен разбору. */
export type SetMode = "single" | "batch" | "json";

/** Разобранный ввод: режим, цель из позиционного и сами записи. */
export interface SetInput {
  readonly mode: SetMode;
  /** Цель, названная первым позиционным в JSON-режиме. */
  readonly target?: string;
  readonly items: readonly SetItem[];
}

/** Аргументы, от которых зависит выбор режима. */
export interface SetArgs {
  readonly range?: string;
  readonly value?: string;
  readonly from?: string;
  readonly literal: boolean;
}

/** Срез порта: файл, stdin и признак терминала — выбор режима по нему. */
export type SetIo = SheetIo & Pick<CommandIo, "stdinIsTerminal">;

const USAGE_SAMPLE = "нечего писать; позови одним из трёх способов:\n" +
  "  mpu sheet set 'Лист!A1' '=SUM(B:B)' -s ЦЕЛЬ\n" +
  "  mpu sheet set --from пакет.tsv -s ЦЕЛЬ\n" +
  '  echo \'[{"range":"Лист!A1","value":"текст"}]\' | mpu sheet set ЦЕЛЬ';

/**
 * Режим выбирается формой вызова, а не флагом (спека, «CLI-контракт»):
 * `--from` — пакет, отсутствие второго позиционного при непустом
 * stdin — JSON, оба позиционных — одна ячейка.
 */
export async function setInput(
  io: SetIo,
  args: SetArgs,
): Promise<SetInput> {
  if (args.from !== undefined) {
    const text = args.from === "-"
      ? await readTextStdin(io)
      : await fileText(io, args.from);
    return { mode: "batch", items: batchItems(text, kindOf(args.literal)) };
  }
  if (args.value === undefined && !io.stdinIsTerminal()) {
    // Первый позиционный здесь означает не диапазон, а цель: диапазоны
    // приходят в самом JSON. Это единственное место, где смысл
    // позиционного меняется, — оттого и сказано в справке прямым
    // текстом.
    return {
      mode: "json",
      target: args.range,
      items: jsonItems(await readTextStdin(io)),
    };
  }
  if (args.range !== undefined && args.value !== undefined) {
    return {
      mode: "single",
      items: [{
        range: args.range,
        kind: kindOf(args.literal),
        value: args.value,
      }],
    };
  }
  throw new UsageError(USAGE_SAMPLE);
}

/** `--literal` задаёт умолчание режимов 1 и 3; JSON его не смотрит. */
function kindOf(literal: boolean): SetKind {
  return literal ? "value" : "formula";
}

/**
 * Пакет из файла: `диапазон<TAB>значение` на строку. Строка без
 * табуляции — отказ с её номером и содержимым: без номера оператор
 * ищет её глазами в файле на сотню строк.
 */
function batchItems(text: string, kind: SetKind): readonly SetItem[] {
  const items: SetItem[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) {
      throw new UsageError(
        `строка ${index + 1} без табуляции: '${line}'`,
      );
    }
    items.push({
      range: line.slice(0, tab).trim(),
      kind,
      value: line.slice(tab + 1),
    });
  }
  if (items.length === 0) {
    // Пустой пакет — не «нечего делать», а ошибка ввода: оператор
    // просил записать и вправе узнать, что не записалось ничего.
    throw new UsageError("пакет пуст: ни одной строки с данными");
  }
  return items;
}

/**
 * JSON из потока: `[{"range": …, "value"|"formula": …}, …]`. Тип
 * задаёт имя свойства, а не флаг — потому в одном пакете сочетаются
 * оба, и потому `--literal` сюда не заглядывает (спека, «Ввод/вывод»).
 */
function jsonItems(text: string): readonly SetItem[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`ввод не разбирается как JSON: ${reason(err)}`);
  }
  if (!Array.isArray(payload)) throw new UsageError("ждался массив записей");
  if (payload.length === 0) {
    throw new UsageError("пустой массив: писать нечего");
  }
  return payload.map((element, index) => item(element, index));
}

/** Одна запись JSON-режима; номер элемента — часть каждого отказа. */
function item(element: unknown, index: number): SetItem {
  const at = `элемент ${index}`;
  if (
    typeof element !== "object" || element === null || Array.isArray(element)
  ) {
    throw new UsageError(`${at}: не объект`);
  }
  const record = element as Readonly<Record<string, unknown>>;
  const range = record.range;
  if (typeof range !== "string" || range.trim() === "") {
    throw new UsageError(`${at}: нет 'range'`);
  }
  const hasFormula = "formula" in record;
  const hasValue = "value" in record;
  if (hasFormula === hasValue) {
    throw new UsageError(
      hasFormula
        ? `${at}: 'formula' и 'value' вместе — выбери одно`
        : `${at}: нет ни 'formula', ни 'value'`,
    );
  }
  return {
    range,
    kind: hasFormula ? "formula" : "value",
    value: hasFormula ? record.formula : record.value,
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
