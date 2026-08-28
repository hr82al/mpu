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
  UsageError,
} from "../command/mod.ts";
import { openSlback, SlbackError } from "../slback/mod.ts";
import {
  BODY_INPUT,
  bodyFromFields,
  EndpointDeclarationError,
  type EndpointSpec,
  type FieldSpec,
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
  for (const field of fields) {
    shape[field.name] = z.string().optional().describe(
      `(${field.type})${
        field.required === true ? " (required)" : ""
      } ${field.help}`,
    );
  }
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
    errorName: `api ${spec.name}`,
    summary: `${spec.method} ${spec.path}`,
    usage: usageOf(spec, params),
    help: helpText(spec, params, fields),
    // Читающая половина семейства: пишущие эндпоинты в таблице этого
    // модуля не объявлены (`api.md`, состав порции).
    policy: "ro",
    // Вывод в журнал — по умолчанию, кроме ответов с чужими секретами
    // (`EndpointSpec.secrets`). Аргументы пишутся всегда: у читающих
    // эндпоинтов это идентификаторы, а не секреты.
    logsOutput: spec.secrets !== true,
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
  const body = raw === undefined
    ? bodyFromFields(fields, args)
    : await bodyArg(raw, io);

  const session = openSlback(io);
  try {
    return { response: await session.call(spec.method, path, body) };
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
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--body: невалидный JSON: ${reasonOf(err)}`, {
      cause: err,
    });
  }
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
}

function usageOf(spec: EndpointSpec, params: readonly string[]): string {
  const tail = [
    ...params.map((name) => name.toUpperCase()),
    ...(spec.fields ?? []).map((field) => `[--${field.name} ЗНАЧЕНИЕ]`),
    ...(spec.body === true ? ["[--body JSON]"] : []),
  ];
  return `mpu api ${spec.name}${tail.length === 0 ? "" : ` ${tail.join(" ")}`}`;
}

function helpText(
  spec: EndpointSpec,
  params: readonly string[],
  fields: readonly FieldSpec[],
): string {
  const parts = [`${spec.method} ${spec.path}`];
  if (spec.about !== undefined) parts.push(spec.about);
  if (params.length > 0) {
    parts.push(
      [
        "Path-аргументы (в порядке пути):",
        ...params.map(
          (name) => `  ${name}: ${helpOf(name)}`,
        ),
      ].join("\n"),
    );
  }
  if (fields.length > 0) {
    parts.push(
      [
        "Поля тела (--<имя> <значение>):",
        ...fields.map((field) =>
          `  --${field.name} (${field.type})${
            field.required === true ? " (required)" : ""
          }: ${field.help}`
        ),
      ].join("\n"),
    );
  }
  if (spec.body === true) {
    parts.push(
      "--body/-b: JSON-литерал либо @путь/к.json; задан — замещает все --<поле>.",
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
