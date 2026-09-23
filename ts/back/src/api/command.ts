/**
 * Фабрика команды из объявления эндпоинта (`api.md`): одна строка
 * таблицы — одна команда `mpu api <имя>`.
 *
 * Разбор входа, вызов и печать здесь общие для всех эндпоинтов; сама
 * команда не знает ни про токен, ни про базовый адрес — это сеанс
 * (`../slback/`). Логики сверх подстановки пути и сборки тела у неё
 * нет и быть не должно: где она появится, там появится и место, где
 * шестьдесят команд разойдутся.
 */

import { z } from "@zod/zod";
import {
  type Command,
  type CommandIo,
  defineCommand,
  DomainError,
  type KeyRename,
  UsageError,
} from "../command/mod.ts";
import { openSlback, SlbackError } from "../slback/mod.ts";
import {
  BODY_INPUT,
  bodyFromFields,
  EndpointDeclarationError,
  type EndpointSpec,
  type FieldSpec,
  type FieldType,
  fillPath,
  PATH_ARG_HELP,
  pathParams,
  reasonOf,
} from "./endpoint.ts";

/** Аргументы декларативной команды: всё приходит текстом из argv. */
type EndpointArgs = Readonly<Record<string, string | undefined>>;

const resultSchema = z.object({
  // Ответ сервера как есть: разбирать его нам нечем — форма у каждого
  // эндпоинта своя, и объявить её значило бы обещать проверку, которой
  // нет (`api.md`, инвариант «команда ничего не добавляет к ответу»).
  response: z.unknown().describe("ответ sl-back как есть; пустой — нет данных"),
});

type EndpointResult = z.infer<typeof resultSchema>;

/** Собирает команду из объявления. */
export function endpointCommand(spec: EndpointSpec): Command {
  const params = pathParams(spec.path);
  const fields = spec.fields ?? [];
  assertDeclaration(spec, params, fields);

  const shape: Record<string, z.ZodType> = {};
  for (const name of params) {
    shape[name] = z.string({ error: `нужен ${name}: ${helpOf(name)}` })
      .describe(helpOf(name));
  }
  for (const field of fields) shape[field.name] = fieldSchema(spec, field);
  if (spec.body === true) {
    shape[BODY_INPUT] = z.string().optional().describe(
      "полный JSON body: '<json>' или @path/to.json",
    );
  }

  const forms: Record<string, { positional?: "one"; short?: string }> = {};
  for (const name of params) forms[name] = { positional: "one" };
  if (spec.body === true) forms[BODY_INPUT] = { short: "b" };

  return defineCommand({
    path: ["api", spec.name],
    keys: pathKeys(params),
    errorName: `api ${spec.name}`,
    summary: `${spec.method} ${spec.path}`,
    usage: usageOf(spec, params),
    help: helpText(spec),
    examples: examplesOf(spec, params),
    // Политика следует методу, а не таблице: `GET` читает, остальные
    // меняют состояние. Объявить `rw`-эндпоинт читающим значило бы
    // выдать его читающему профилю MCP-сервера, где мутациям места
    // нет (`platform/mcp-server.md`).
    policy: spec.method === "GET" ? "ro" : "rw",
    // Вывод в журнал — по умолчанию, кроме ответов, которым не место на
    // диске (`EndpointSpec.sensitiveOutput`). Аргументы пишутся всегда:
    // у читающих эндпоинтов это идентификаторы, а не секреты.
    logsOutput: spec.sensitiveOutput !== true,
    // Аргументы пишутся всегда, кроме команд, чьи поля несут секрет:
    // у читающей половины это были идентификаторы, а в остатке есть
    // `--password` и `--token`, и строка `$ mpu api …` легла бы на
    // диск вместе с ними (`api-write.md`).
    logsArguments: spec.secretInput !== true,
    // Схема собрана из данных, и её тип известен только в рантайме:
    // ключи приходят из пути и списка полей. Значения при этом все
    // строковые — сужение делает не приведение, а сама схема.
    argsSchema: z.object(shape) as z.ZodType<EndpointArgs>,
    forms,
    resultSchema,
    run: (args, io) => runEndpoint(spec, params, fields, args, io),
    render: (result: EndpointResult) => renderResponse(result.response),
  });
}

/**
 * Ключи параметров пути (`platform/keys-translation.md`): внутренний —
 * `id:`, внешние — по имени сущности (`:clientId` → `client:`).
 */
function pathKeys(
  params: readonly string[],
): Record<string, string | KeyRename> {
  const keys: Record<string, string | KeyRename> = {};
  for (const [at, param] of params.entries()) {
    const key = pathKeyOf(params, at);
    keys[key] = key === param || key === "id" ? param : {
      input: param,
      why: `параметр пути :${param} — по имени сущности`,
    };
  }
  return keys;
}

/** Ключ параметра пути номер `at`: последний — `id`, прочие — сущность. */
function pathKeyOf(params: readonly string[], at: number): string {
  if (at === params.length - 1) return "id";
  return params[at].replace(/Id$/, "");
}

/** Добавляет к ошибке ввода ту же подсказку, что даёт разбор схемы. */
function withHelpHint<T>(spec: EndpointSpec, body: () => T): T {
  try {
    return body();
  } catch (err) {
    if (!(err instanceof UsageError) || err.hint !== undefined) throw err;
    throw new UsageError(err.message, {
      hint: `mpu api ${spec.name} --help`,
      cause: err,
    });
  }
}

/**
 * Схема поля тела. Обязательность объявляется схемой, а не только
 * текстом описания: раньше поле было `optional()` при любом
 * `required`, обязательность жила в скобках `(required)` и всплывала
 * отказом при разборе — то есть машине и человеку говорили разное, и
 * обманут был именно тот, кто читает схему (агент, MCP-клиент).
 *
 * У команды, принимающей `--body`, обязательность **условна**: тело
 * замещает поля целиком, и тогда ни одно из них не нужно. Условие
 * схемой не выражается — ветвление в схеме тула запрещено инвариантом
 * (`src/mcp/invariants_test.ts`), — поэтому такое поле остаётся
 * необязательным, а условие названо словами в описании. Отказ при
 * разборе для него по-прежнему даёт `bodyFromFields`.
 *
 * Текст отказа сохраняется дословно (`--<имя> обязателен`): он снят
 * живой парой с оригинала (`api-write.md`, инвариант 4) и меняться от
 * того, какой слой его бросил, не должен.
 */
function fieldSchema(spec: EndpointSpec, field: FieldSpec): z.ZodType {
  if (schemaRequires(spec, field)) {
    // Пометки в тексте здесь нет намеренно: обязательность несёт сама
    // схема, а справка печатает её из схемы («(обязателен)»,
    // `src/entrypoint/help.ts`). Написать её ещё и словами значило бы
    // назвать один факт дважды в одной строке.
    return z.string({ error: `--${field.name} обязателен` }).describe(
      `(${field.type}) ${field.help}`,
    );
  }
  return z.string().optional().describe(
    `(${field.type})${requirementMark(spec, field)} ${field.help}`,
  );
}

/** Объявляет ли схема поле обязательным: только там, где это безусловно. */
function schemaRequires(spec: EndpointSpec, field: FieldSpec): boolean {
  return field.required === true && spec.body !== true;
}

/**
 * Пометка обязательности словами — там, где схема сказать не может:
 * описание поля, из которого раздел «Ключи» справки печатает его строку.
 */
function requirementMark(spec: EndpointSpec, field: FieldSpec): string {
  if (field.required !== true) return "";
  return spec.body === true ? ` (required, если не задан ${BODY_INPUT}:)` : "";
}

/**
 * Печать ответа: JSON с отступом 2 и unicode как есть, ровно как
 * пришло. Пустой ответ — пустой stdout, а не `null` и не `{}`.
 */
function renderResponse(response: unknown): string {
  if (response === undefined) return "";
  return `${JSON.stringify(response, null, 2)}\n`;
}

async function runEndpoint(
  spec: EndpointSpec,
  params: readonly string[],
  fields: readonly FieldSpec[],
  args: EndpointArgs,
  io: CommandIo,
): Promise<EndpointResult> {
  // Весь ввод разбирается до сети: негодное число или нечитаемый файл
  // тела не стоят обращения наружу (`api.md`, инвариант).
  const values: Record<string, string> = {};
  for (const name of params) {
    const value = args[name];
    // Схема объявила path-параметр обязательным, поэтому значение здесь
    // есть всегда; пропуск — на случай, если объявление разойдётся со
    // схемой: тогда отказ придёт из `fillPath`, а не подстановкой пустоты.
    if (value !== undefined) values[name] = value;
  }
  const path = fillPath(spec.path, values);
  const raw = spec.body === true ? args[BODY_INPUT] : undefined;
  // Отказ «поля не хватает» приходит из двух мест: у команды без
  // `--body` его бросает схема (там же и подсказка), у команды с
  // `--body` — разбор полей. Подсказка добавляется здесь, чтобы одна
  // и та же нехватка печаталась одинаково независимо от слоя.
  const body = raw === undefined
    ? withHelpHint(spec, () => bodyFromFields(fields, args))
    : await bodyArg(raw, io);

  const session = openSlback(io);
  try {
    return {
      response: await session.call(spec.method, path, body, {
        auth: spec.noAuth !== true,
      }),
    };
  } catch (err) {
    throw asDomainError(err);
  }
}

/**
 * Отказ вызова как ошибка команды: текст атома плюс тело ответа
 * отдельной строкой. Тело печатает точка входа из `details` — в строку
 * ошибки оно не вклеивается (`api.md`, «Ввод/вывод»).
 */
export function asDomainError(err: unknown): unknown {
  if (!(err instanceof SlbackError)) return err;
  return new DomainError(err.message, {
    details: err.body === "" ? undefined : err.body,
    cause: err,
  });
}

/** Значение `--body`: JSON-литерал либо содержимое файла по `@путь`. */
async function bodyArg(raw: string, io: CommandIo): Promise<unknown> {
  let text = raw;
  if (raw.startsWith("@")) {
    const path = raw.slice(1);
    try {
      text = await io.readTextFile(path);
    } catch (err) {
      throw new UsageError(`--body @${path}: ${reasonOf(err)}`, { cause: err });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--body: невалидный JSON: ${reasonOf(err)}`, {
      cause: err,
    });
  }
  // Тело запроса — объект, и произвольность его этого не отменяет:
  // массив или строка уйдут на сервер телом, которого он не ждёт, и
  // отказ придёт оттуда, а не отсюда (`api-write.md`, механика 2).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(
      `--body: ожидается объект JSON, получено ${shapeOf(parsed)}`,
    );
  }
  return parsed;
}

/** Что пришло вместо объекта — словом, для текста отказа. */
function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "массив";
  return typeof value === "string" ? "строку" : `${typeof value}`;
}

/** Пояснение к path-параметру; незаполненное — само имя (`PATH_ARG_HELP`). */
function helpOf(name: string): string {
  return PATH_ARG_HELP[name] ?? name;
}

/** Противоречия объявления ловятся при сборке реестра, а не при вызове. */
function assertDeclaration(
  spec: EndpointSpec,
  params: readonly string[],
  fields: readonly FieldSpec[],
): void {
  const names = new Set<string>(params);
  for (const field of fields) {
    if (names.has(field.name)) {
      throw new EndpointDeclarationError(
        `${spec.name}: имя ${field.name} занято path-параметром`,
      );
    }
    names.add(field.name);
  }
  if (spec.body === true && names.has(BODY_INPUT)) {
    throw new EndpointDeclarationError(
      `${spec.name}: имя ${BODY_INPUT} занято`,
    );
  }
  // Ключи строки выводятся из имён, и два входа могут сойтись в одном.
  const keys = [
    ...params.map((_, at) => pathKeyOf(params, at)),
    ...fields.map(fieldKey),
  ];
  const twice = keys.find((key, at) => keys.indexOf(key) !== at);
  if (twice !== undefined) {
    throw new EndpointDeclarationError(
      `${spec.name}: ключ ${twice}: у двух входов`,
    );
  }
}

/** Как вход пишется ключом: параметр пути — по `pathKeys`, поле — своим именем. */
function keyWords(params: readonly string[]): ReadonlyMap<string, string> {
  const keys = Object.entries(pathKeys(params)).map(([key, declared]) =>
    [typeof declared === "string" ? declared : declared.input, key] as const
  );
  return new Map(keys);
}

/** Имя ключа поля тела: подчёркивание — через дефис, как у всех ключей. */
function fieldKey(field: FieldSpec): string {
  return field.name.replaceAll("_", "-");
}

function usageOf(spec: EndpointSpec, params: readonly string[]): string {
  const keys = keyWords(params);
  const tail = [
    ...params.map((name) => `${keys.get(name)}: ${name.toUpperCase()}`),
    ...(spec.fields ?? []).map((field) =>
      // Скобки значат «необязателен», и у поля, которого схема
      // требует, их быть не должно: строка использования — та же
      // правда, что и схема.
      schemaRequires(spec, field)
        ? `${fieldKey(field)}: ЗНАЧЕНИЕ`
        : `[${fieldKey(field)}: ЗНАЧЕНИЕ]`
    ),
    ...(spec.body === true ? [`[${BODY_INPUT}: JSON]`] : []),
  ];
  return `mpu api ${spec.name}${tail.length === 0 ? "" : ` ${tail.join(" ")}`}`;
}

/** Пробное значение параметра пути для примера справки. */
const SAMPLE_PARAM: Readonly<Record<string, string>> = {
  userId: "7",
  clientId: "54",
  spreadsheetId: "1AbCdEf",
  spreadsheet_id: "1AbCdEf",
  sheetName: "UNIT",
  sid: "12345",
  module: "wb",
};

/** Пробное значение обязательного поля по его типу. */
const SAMPLE_FIELD: Readonly<Record<FieldType, string>> = {
  string: "ЗНАЧЕНИЕ",
  number: "1",
  boolean: "true",
  json: "[]",
};

/**
 * Примеры справки: параметры пути и обязательные поля ключами (у
 * эндпоинта с телом — обязательные без `body:`); тело целиком — вторым
 * примером, из файла.
 */
function examplesOf(
  spec: EndpointSpec,
  params: readonly string[],
): readonly string[] {
  const keys = keyWords(params);
  const words = [
    `mpu api ${spec.name}`,
    ...params.map((name) => `${keys.get(name)}: ${SAMPLE_PARAM[name] ?? name}`),
  ];
  const required = (spec.fields ?? []).filter((field) =>
    field.required === true
  ).map((field) => `${fieldKey(field)}: ${SAMPLE_FIELD[field.type]}`);
  const plain = [...words, ...required].join(" ");
  if (spec.body !== true) return [plain];
  return [plain, `${words.join(" ")} ${BODY_INPUT}: @req.json`];
}

function helpText(spec: EndpointSpec): string {
  const parts = [
    `Звать, когда нужен прямой вызов sl-back ${spec.method} ${spec.path}: ` +
    "ответ приходит как есть, без разбора и пересчёта.",
  ];
  if (spec.about !== undefined) parts.push(spec.about);
  if (spec.body === true) {
    parts.push(
      `${BODY_INPUT}: — JSON-литерал либо @путь/к.json; задан — замещает ` +
        "все поля тела.",
    );
  }
  parts.push(
    `stdout — ответ sl-back как есть, JSON с отступом 2; пустой ответ — пустой
stdout. Ключи env-файла — BASE_API_URL / NEXT_PUBLIC_SERVER_URL (адрес),
TOKEN_EMAIL / TOKEN_PASSWORD (логин); токен кэшируется на 10 минут.

Exit: 0 — успех; 2 — ошибки ввода (до сети); 1 — сеть, HTTP ≥ 400,
невалидный ответ, отсутствие конфигурации.`,
  );
  return parts.join("\n\n");
}
