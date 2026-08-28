/**
 * Объявление эндпоинта sl-back и разбор ввода под него (`api.md`,
 * «Декларативные команды»).
 *
 * Эндпоинт — данные: метод, путь и поля тела. Всё остальное — имя
 * команды, справка, позиционные аргументы, типизация полей — выводится
 * отсюда одинаково для всех, поэтому новая команда добавляется строкой
 * таблицы (`endpoints.ts`), а не новым кодом, который может разойтись с
 * соседним.
 */

import { UsageError } from "../command/mod.ts";

/** Тип поля тела: чем текст из argv станет в JSON запроса. */
export type FieldType = "string" | "number" | "boolean" | "json";

/** Поле тела запроса; имя поля — точное имя опции, регистр значим. */
export interface FieldSpec {
  readonly name: string;
  readonly type: FieldType;
  readonly required?: true;
  /** Хвост строки справки после типа. */
  readonly help: string;
}

/** Объявление эндпоинта: строка таблицы. */
export interface EndpointSpec {
  /** Имя подкоманды: `mpu api <name>`. */
  readonly name: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Путь с `:param`-сегментами; они же — позиционные аргументы. */
  readonly path: string;
  /** Поля тела; нет — запрос уходит без тела. */
  readonly fields?: readonly FieldSpec[];
  /** Принимает ли `--body/-b` целиком вместо полей. */
  readonly body?: true;
  /** Абзац описания сверх строки «метод + путь». */
  readonly about?: string;
}

/**
 * Пояснения к path-параметрам: одно и то же `:clientId` встречается в
 * дюжине путей, и держать его описание в каждой строке таблицы значило
 * бы двенадцать мест для одной опечатки.
 *
 * Незаполненная запись — не отказ: строка таблицы обязана оставаться
 * единственной правкой на новый эндпоинт, а справка без пояснения
 * хуже, но работает. Полноту таблицы стережёт тест, а не исключение на
 * пути импорта: оно уронило бы весь `mpu`, а не одну команду.
 */
export const PATH_ARG_HELP: Readonly<Record<string, string>> = {
  userId: "numeric user/client id",
  clientId: "numeric client_id",
  spreadsheetId: "spreadsheet_id (Google Sheets)",
  spreadsheet_id: "spreadsheet_id (Google Sheets)",
  sheetName: "sheet (=dataset) name",
  sid: "WB seller sid",
  module:
    "имя модуля (список — list-client-modules / list-wb-cabinet-modules;" +
    " модули предзаведены, только вкл/выкл)",
};

/** Имя входа под `--body/-b`; занято, полем тела быть не может. */
export const BODY_INPUT = "body";

/** Объявление таблицы противоречиво — дефект, видимый при сборке реестра. */
export class EndpointDeclarationError extends Error {
  override name = "EndpointDeclarationError";
}

/** Имена `:param`-сегментов пути в порядке появления. */
export function pathParams(path: string): readonly string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
}

/**
 * Путь запроса с подставленными значениями. Значение экранируется
 * целиком, включая `/`: идентификатор приходит от оператора, и
 * `sheetName` вида `Лист/1` обязан остаться одним сегментом, а не
 * увести запрос на соседний эндпоинт.
 *
 * Экранирования мало: `.` и `..` — законные символы URL, и
 * `encodeURIComponent` их не трогает, а конструктор `URL` схлопывает
 * такой сегмент вместе с соседним ещё до отправки. `get-client ..`
 * ушло бы на `GET /admin/`, а в пишущей половине `delete-client ..` —
 * на `DELETE /admin/`. Поэтому оба значения отбиваются как ошибка
 * ввода; percent-форма (`%2e%2e`) опасной не является: она сама
 * экранируется и до точки уже не декодируется.
 */
export function fillPath(
  path: string,
  values: Readonly<Record<string, string>>,
): string {
  return path.replaceAll(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_all, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new EndpointDeclarationError(`нет значения для :${name}`);
    }
    if (value === "." || value === "..") {
      throw new UsageError(
        `${name}: '${value}' — не идентификатор, а сегмент пути`,
      );
    }
    return encodeURIComponent(value);
  });
}

/**
 * Тело запроса из заданных полей. Незаданные поля в тело не входят; ни
 * одного заданного — тела нет вовсе (`undefined`).
 */
export function bodyFromFields(
  fields: readonly FieldSpec[],
  raw: Readonly<Record<string, string | undefined>>,
): unknown {
  const body: Record<string, unknown> = {};
  let any = false;
  for (const field of fields) {
    const value = raw[field.name];
    if (value === undefined) {
      if (field.required === true) {
        throw new UsageError(`--${field.name} обязателен`);
      }
      continue;
    }
    body[field.name] = typedValue(field, value);
    any = true;
  }
  return any ? body : undefined;
}

/** Значение поля по его объявленному типу; негодный текст — ошибка ввода. */
export function typedValue(field: FieldSpec, value: string): unknown {
  switch (field.type) {
    case "string":
      return value;
    case "number":
      return numberValue(field.name, value);
    case "boolean":
      return booleanValue(field.name, value);
    case "json":
      return jsonValue(field.name, value);
  }
}

const TRUE_WORDS = ["true", "yes", "1", "on"];
const FALSE_WORDS = ["false", "no", "0", "off"];

function numberValue(name: string, value: string): number {
  // Дробным число делает форма записи, а не значение: `2.0` уходит на
  // сервер дробным, `2` — целым. Сервер различает их схемой тела.
  const fractional = /[.eE]/.test(value);
  const parsed = fractional ? Number.parseFloat(value) : Number.parseInt(value);
  // `parseInt`/`parseFloat` дочитывают до первого негодного символа и
  // молча берут префикс: `12abc` дало бы 12. Форму проверяет regexp,
  // а не результат разбора.
  const wellFormed = fractional
    ? /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)
    : /^[+-]?\d+$/.test(value);
  if (!wellFormed || Number.isNaN(parsed)) {
    throw new UsageError(
      `--${name}: ожидается число, получено '${value}'`,
    );
  }
  return parsed;
}

function booleanValue(name: string, value: string): boolean {
  const word = value.toLowerCase();
  if (TRUE_WORDS.includes(word)) return true;
  if (FALSE_WORDS.includes(word)) return false;
  throw new UsageError(
    `--${name}: ожидается boolean (true/false/yes/no/1/0), получено '${value}'`,
  );
}

function jsonValue(name: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new UsageError(
      `--${name}: ожидается JSON, получено '${value.slice(0, 60)}...': ${
        reasonOf(err)
      }`,
      { cause: err },
    );
  }
}

/** Причина отказа разбора одной строкой. */
export function reasonOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}
