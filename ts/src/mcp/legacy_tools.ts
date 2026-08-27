/**
 * Команды маршрута `legacy` как тулы (`platform/mcp-server.md`, «Два
 * источника тулов»). Схема аргументов выводится из описания параметров
 * в машинном слепке дерева, а вызов собирает из объекта аргументов
 * командную строку подпроцесса.
 *
 * Сборка списка — не деталь: агент звал такие команды через Bash, и
 * список значений уезжал одной строкой, после чего команда молча
 * обрабатывала ноль элементов. Здесь каждый элемент списка становится
 * отдельным аргументом argv, а argv уходит подпроцессу массивом, минуя
 * shell, — склеить нечем.
 */

import { UsageError } from "../command/mod.ts";
import type { JsonSchema, Profile, ToolEntry } from "./tool.ts";
import { toolName } from "./tool.ts";
import { resolveLegacyBin } from "../legacy/mod.ts";

/**
 * Версия формата слепка, которую понимает этот код. Версия 2 добавила
 * записи узлов дерева: у группы есть свои summary и help, признак —
 * поле `group` (`platform/registry.md`).
 */
export const MANIFEST_VERSION = 2;

/**
 * Предел вывода подпроцесса. Фиксирован реализацией и параметром тула
 * не является (спека): у чужого подпроцесса ограничивать нечего, кроме
 * уже полученного текста, — ручка в схеме аргументов регулировала бы
 * пустоту.
 */
export const OUTPUT_LIMIT = 32 * 1024;

/** Предел описания тула: клиент обрезает его ровно на этом месте. */
const DESCRIPTION_LIMIT = 2048;

/** Параметр команды, как его описывает слепок. */
export interface LegacyParam {
  readonly name: string;
  /** `argument` — позиционный, `option` — флаг. */
  readonly kind: "argument" | "option";
  readonly type: "string" | "boolean" | "integer" | "number";
  readonly required: boolean;
  readonly help?: string;
  /** Формы записи флага; первая — длинная. */
  readonly opts?: readonly string[];
  /** Отрицающие формы булева флага (`--no-update`). */
  readonly negatedOpts?: readonly string[];
  readonly default?: unknown;
  readonly choices?: readonly string[];
  /** Флаг повторяем: каждое значение — отдельная пара «имя значение». */
  readonly multiple?: boolean;
  /** `-1` у позиционного: забирает остаток, значит список. */
  readonly nargs?: number;
}

/**
 * Узел слепка: исполнимая команда либо группа. Тулом становится только
 * лист — у группы нечего исполнять (`platform/mcp-server.md`).
 */
export interface LegacyLeaf {
  readonly path: readonly string[];
  readonly params: readonly LegacyParam[];
  readonly summary: string;
  readonly help: string;
  /** Узел дерева, а не команда: подкоманды есть, исполнения нет. */
  readonly group?: boolean;
}

/** Слепок дерева команд целиком. */
export interface Manifest {
  readonly manifestVersion: number;
  readonly mpuVersion: string;
  readonly commands: readonly LegacyLeaf[];
}

/** Слепок незнакомого формата: разбирать его вслепую нельзя. */
export class ManifestError extends Error {
  override name = "ManifestError";
}

/**
 * Читает слепок как внешние данные: проверяет версию формата и форму
 * записей. Незнакомая версия — отказ с обеими версиями в тексте:
 * попытка разобрать её как знакомую дала бы тулы с неверными схемами,
 * а это хуже отсутствия тулов.
 */
export function readManifest(raw: unknown): Manifest {
  const root = record(raw, "слепок дерева");
  const version = root["manifestVersion"];
  if (version !== MANIFEST_VERSION) {
    throw new ManifestError(
      `слепок дерева версии ${String(version)}, ` +
        `а этот код понимает версию ${MANIFEST_VERSION}`,
    );
  }
  const commands = root["commands"];
  if (!Array.isArray(commands)) {
    throw new ManifestError("слепок дерева: commands не массив");
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    mpuVersion: text(root["mpuVersion"], "слепок дерева: mpuVersion"),
    commands: commands.map(readLeaf),
  };
}

function readLeaf(raw: unknown, index: number): LegacyLeaf {
  const where = `слепок дерева: лист ${index}`;
  const leaf = record(raw, where);
  const path = leaf["path"];
  if (!Array.isArray(path) || path.length === 0) {
    throw new ManifestError(`${where}: path пуст или не массив`);
  }
  const params = leaf["params"];
  if (!Array.isArray(params)) {
    throw new ManifestError(`${where}: params не массив`);
  }
  const name = path.map((segment) => text(segment, `${where}: сегмент пути`));
  return {
    path: name,
    summary: text(leaf["summary"], `${where}: summary`),
    help: text(leaf["help"], `${where}: help`),
    params: params.map((param) => readParam(param, name.join(" "))),
    ...(leaf["group"] === true ? { group: true } : {}),
  };
}

function readParam(raw: unknown, command: string): LegacyParam {
  const where = `слепок дерева: параметр команды ${command}`;
  const param = record(raw, where);
  const kind = param["kind"];
  if (kind !== "argument" && kind !== "option") {
    throw new ManifestError(`${where}: неизвестный kind ${String(kind)}`);
  }
  const type = param["type"];
  if (
    type !== "string" && type !== "boolean" && type !== "integer" &&
    type !== "number"
  ) {
    throw new ManifestError(`${where}: неизвестный type ${String(type)}`);
  }
  return {
    name: text(param["name"], `${where}: name`),
    kind,
    type,
    required: param["required"] === true,
    ...optional("help", optionalText(param["help"])),
    ...optional("opts", optionalTexts(param["opts"])),
    ...optional("negatedOpts", optionalTexts(param["negatedOpts"])),
    ...optional("choices", optionalTexts(param["choices"])),
    ...optional("default", param["default"]),
    ...optional("multiple", param["multiple"] === true ? true : undefined),
    ...optional(
      "nargs",
      typeof param["nargs"] === "number" ? param["nargs"] : undefined,
    ),
  };
}

/** Ключ появляется в объекте, только если значение задано. */
function optional(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function record(value: unknown, where: string): Readonly<
  Record<string, unknown>
> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(`${where}: ожидался объект`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = item;
  return out;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new ManifestError(`${where}: ожидалась строка`);
  }
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalTexts(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => text(item, "слепок дерева: элемент списка"));
}

/** Поле схемы аргументов тула. */
interface SchemaProperty {
  readonly type: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly enum?: readonly string[];
  readonly items?: { readonly type: string };
}

/** Схема аргументов тула: плоский объект без ветвлений. */
export interface LegacyToolSchema extends JsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, SchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

/** Схема аргументов из описания параметров листа. */
export function legacyToolSchema(leaf: LegacyLeaf): LegacyToolSchema {
  const properties: Record<string, SchemaProperty> = {};
  const required: string[] = [];
  for (const param of leaf.params) {
    properties[param.name] = propertyOf(param);
    if (param.required) required.push(param.name);
  }
  const schema: LegacyToolSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  return required.length === 0 ? schema : { ...schema, required };
}

function propertyOf(param: LegacyParam): SchemaProperty {
  const scalar = scalarType(param.type);
  const base = isList(param)
    ? { type: "array", items: { type: scalar } }
    : { type: scalar };
  return {
    ...base,
    ...(param.help === undefined ? {} : { description: param.help }),
    ...(param.choices === undefined ? {} : { enum: param.choices }),
    ...(param.default === undefined ? {} : { default: param.default }),
  };
}

/** Список — повторяемый флаг либо позиционный, забирающий остаток. */
function isList(param: LegacyParam): boolean {
  return param.multiple === true || param.nargs === -1;
}

function scalarType(type: LegacyParam["type"]): string {
  return type === "number" ? "number" : type;
}

/**
 * Проверяет объект аргументов по схеме листа: неизвестное имя и
 * пропущенный обязательный параметр — ошибка ввода, а не молчаливое
 * игнорирование. Молчание здесь — тот же класс бед, что склеенный
 * список: агент считает, что его услышали, а команда получила не то.
 */
export function checkLegacyArgs(
  leaf: LegacyLeaf,
  raw: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UsageError("arguments must be an object");
  }
  const args: Record<string, unknown> = { ...raw };
  const known = new Set(leaf.params.map((param) => param.name));
  for (const name of Object.keys(args)) {
    if (!known.has(name)) {
      throw new UsageError(`unknown argument "${name}"`);
    }
  }
  for (const param of leaf.params) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required) {
        throw new UsageError(`missing required argument "${param.name}"`);
      }
      continue;
    }
    const problem = valueProblem(param, value);
    if (problem !== undefined) {
      throw new UsageError(`${param.name}: ${problem}`);
    }
  }
  return args;
}

/**
 * Проекция команды маршрута `legacy` в тул: описание и схема — из
 * слепка, исполнение — подпроцессом. Ненулевой код возврата приходит
 * признаком ошибки в результате, а не JSON-RPC-ошибкой: доменную
 * ошибку агент читает и исправляет, транспортный сбой — нет.
 */
export function legacyEntry(leaf: LegacyLeaf, profile: Profile): ToolEntry {
  return {
    tool: {
      name: toolName(leaf.path),
      title: `mpu ${leaf.path.join(" ")}`,
      description: legacyToolDescription(leaf),
      annotations: { readOnlyHint: profile === "ro" },
      inputSchema: legacyToolSchema(leaf),
    },
    policy: profile,
    path: leaf.path,
    // Формат ошибок команды до тула этого маршрута не доходит: отказ
    // подпроцесса приходит его же текстом. Имя тут — для полноты записи.
    errorName: leaf.path[0],
    invoke: async (args, io) => {
      // Проверка до запуска: неизвестное имя и пропущенный обязательный
      // параметр — ошибка ввода, её агент исправляет сам, а не узнаёт
      // из молчания подпроцесса.
      const checked = checkLegacyArgs(leaf, args);
      const bin = resolveLegacyBin(io);
      const outcome = await io.runLegacy(bin, legacyToolArgv(leaf, checked));
      if (outcome.code === 0) {
        return { isError: false, text: truncateOutput(outcome.stdout) };
      }
      return {
        isError: true,
        text: truncateOutput(
          `${outcome.stdout}${outcome.stderr}`.trim() ||
            `команда завершилась с кодом ${outcome.code}`,
        ),
      };
    },
  };
}

/** Несоответствие значения объявленному типу; всё в порядке — undefined. */
function valueProblem(param: LegacyParam, value: unknown): string | undefined {
  if (isList(param)) {
    if (!Array.isArray(value)) return "expected array";
    const scalars = value.every((item) =>
      typeof item === "string" || typeof item === "number"
    );
    return scalars ? undefined : "expected array of scalars";
  }
  if (Array.isArray(value)) return "expected scalar, received array";
  if (param.type === "boolean" && typeof value !== "boolean") {
    return `expected boolean, received ${typeof value}`;
  }
  if (
    (param.type === "integer" || param.type === "number") &&
    typeof value !== "number"
  ) {
    return `expected number, received ${typeof value}`;
  }
  if (param.choices !== undefined && !param.choices.includes(String(value))) {
    return `expected one of ${param.choices.join(", ")}`;
  }
  return undefined;
}

/**
 * Командная строка подпроцесса: путь команды, затем флаги, затем
 * позиционные в порядке объявления. Каждый элемент списка — отдельный
 * аргумент; экранировать ничего не нужно, потому что argv уходит
 * подпроцессу массивом, а не через shell.
 */
export function legacyToolArgv(
  leaf: LegacyLeaf,
  args: Readonly<Record<string, unknown>>,
): readonly string[] {
  const argv = [...leaf.path];
  for (const param of leaf.params) {
    if (param.kind !== "option") continue;
    argv.push(...optionArgv(param, args[param.name]));
  }
  for (const param of leaf.params) {
    if (param.kind !== "argument") continue;
    argv.push(...positionalArgv(args[param.name]));
  }
  return argv;
}

function optionArgv(
  param: LegacyParam,
  value: unknown,
): readonly string[] {
  if (value === undefined || value === null) return [];
  // Значение, совпадающее с умолчанием, не пишется: командная строка
  // короче, а поведение то же — умолчание подставит сама реализация.
  if (param.default !== undefined && value === param.default) return [];
  const flag = longestOpt(param);
  if (param.type === "boolean") {
    if (value === true) return [flag];
    // Ложь говорится отрицающей формой, если она есть: у флага с
    // умолчанием `true` иначе не выключить.
    const negated = param.negatedOpts?.[0];
    return negated === undefined ? [] : [negated];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => [flag, String(item)]);
  }
  return [flag, String(value)];
}

/**
 * Форма записи флага: длинная, если она есть. Короткие формы у слепка
 * идут первыми (`-e`, `--expr`), но в командной строке подпроцесса
 * читаемее длинная, а разбирает он обе.
 */
function longestOpt(param: LegacyParam): string {
  const long = param.opts?.find((opt) => opt.startsWith("--"));
  return long ?? param.opts?.[0] ?? `--${param.name}`;
}

function positionalArgv(value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/**
 * Описание тула: однострока и справка из слепка. Не влезло в предел
 * клиента — усекается здесь, по границе строки и с пометкой: молчаливая
 * обрезка на стороне клиента неотличима от конца текста.
 */
export function legacyToolDescription(leaf: LegacyLeaf): string {
  return truncateText(
    `${leaf.summary}\n\n${leaf.help}`,
    DESCRIPTION_LIMIT,
    (dropped) => `[справка усечена: отброшено ${dropped} байт]`,
  );
}

/** Вывод подпроцесса, усечённый по пределу реализации. */
export function truncateOutput(text: string): string {
  return truncateText(
    text,
    OUTPUT_LIMIT,
    (dropped) => `[вывод усечён: отброшено ${dropped} байт]`,
  );
}

const utf8 = new TextEncoder();

/**
 * Усечение по границе строки: отбрасываются целые строки с конца, пока
 * текст вместе с пометкой не уложится в предел. Пометка — часть текста,
 * поэтому её длина считается вместе с ним.
 *
 * Длины строк считаются один раз префиксными суммами, а число
 * оставляемых строк ищется делением пополам: перебор с конца сшивал и
 * перекодировал текст на каждом шаге, и на выводе в сотни килобайт это
 * занимало десятки секунд.
 */
function truncateText(
  text: string,
  limit: number,
  note: (dropped: number) => string,
): string {
  const total = utf8.encode(text).length;
  if (total <= limit) return text;
  const lines = text.split("\n");
  // prefix[i] — байт в первых i строках вместе с переводами между ними.
  const prefix = [0];
  for (const line of lines) {
    const previous = prefix[prefix.length - 1];
    prefix.push(
      previous + utf8.encode(line).length + (prefix.length > 1 ? 1 : 0),
    );
  }
  const fits = (kept: number): boolean => {
    const head = prefix[kept];
    const dropped = total - head;
    return head + 1 + utf8.encode(note(dropped)).length <= limit;
  };

  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  // Даже первая строка не влезла: отдаём одну пометку — она короткая и
  // честнее пустоты.
  if (low === 0) return note(total);
  const head = lines.slice(0, low).join("\n");
  return `${head}\n${note(total - prefix[low])}`;
}
