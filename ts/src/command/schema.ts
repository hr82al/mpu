/**
 * Чтение схемы аргументов как JSON Schema. Источник истины — объявление
 * команды на zod; наружу отдаётся ровно то, что нужно двум потребителям:
 * разбору argv в CLI и схеме входа тула в MCP. Разбор идёт через
 * сериализацию и проверки, а не приведение типов: схема обязана быть
 * представима как JSON в обеих точках входа.
 */

/** Поле схемы: то, что нужно знать о нём разбору argv. */
export interface SchemaField {
  /** `"string" | "boolean" | "array" | …`; отсутствует у пустой схемы. */
  readonly type?: string;
  /** Значение по умолчанию; присутствие делает поле необязательным. */
  readonly default?: unknown;
  /** Допустимые значения перечисления, если поле им ограничено. */
  readonly enum?: readonly unknown[];
  /** Человекочитаемое описание входа. */
  readonly description?: string;
}

/** Схема объекта: корень схемы аргументов и схемы результата. */
export interface ObjectSchema {
  readonly type: string;
  readonly properties: Readonly<Record<string, SchemaField>>;
  readonly required?: readonly string[];
}

/** Схема нечитаема как объект с полями — дефект объявления команды. */
export class SchemaShapeError extends Error {
  override name = "SchemaShapeError";
}

/**
 * Приводит результат `z.toJSONSchema` к дескриптору выше. Схема, корень
 * которой не объект, отвергается здесь — это инвариант 7 контракта, и
 * ловить его лучше при сборке реестра, чем при вызове команды.
 */
export function readObjectSchema(value: unknown, what: string): ObjectSchema {
  const root = asRecord(JSON.parse(JSON.stringify(value)), what);
  const type = root["type"];
  if (type !== "object") {
    throw new SchemaShapeError(`${what}: корень схемы не объект`);
  }
  const properties: Record<string, SchemaField> = {};
  const rawProperties = root["properties"];
  if (rawProperties !== undefined) {
    for (const [key, field] of Object.entries(asRecord(rawProperties, what))) {
      properties[key] = readField(field, `${what}.${key}`);
    }
  }
  return { type, properties, required: readRequired(root["required"], what) };
}

function readField(value: unknown, what: string): SchemaField {
  const record = asRecord(value, what);
  return {
    type: optionalString(record["type"]),
    default: record["default"],
    enum: Array.isArray(record["enum"]) ? record["enum"] : undefined,
    description: optionalString(record["description"]),
  };
}

function readRequired(
  value: unknown,
  what: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new SchemaShapeError(`${what}: "required" не массив`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new SchemaShapeError(`${what}: "required" содержит не строку`);
    }
    return item;
  });
}

function asRecord(
  value: unknown,
  what: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaShapeError(`${what}: ожидался объект схемы`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = item;
  return out;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
