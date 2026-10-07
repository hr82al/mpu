/**
 * Сверка значения со схемой `schema.json` для тестов: подмножество JSON
 * Schema, которым схема написана, — `type`, `enum`, `pattern`, `required`,
 * `properties`, `additionalProperties: false`, `items`, `oneOf`, `$ref` в
 * `$defs`. Зависимости-валидатора у проекта нет; слово схемы вне
 * подмножества — отказ, а не молчаливый пропуск.
 */

/** Узел схемы — объект JSON. */
type Node = Readonly<Record<string, unknown>>;

const KNOWN = new Set([
  "description",
  "type",
  "enum",
  "pattern",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "oneOf",
  "$ref",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function fits(type: string, value: unknown): boolean {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

/**
 * Нарушения схемы: по строке `путь: что не так`; пусто — значение
 * подходит.
 *
 * @param root схема целиком (для `$ref`)
 * @param node узел схемы, по которому сверяется `value`
 * @param at путь значения для текста нарушения
 */
export function violations(
  root: Node,
  node: Node,
  value: unknown,
  at = "$",
): string[] {
  const unknown = Object.keys(node).filter((word) => !KNOWN.has(word));
  if (unknown.length > 0) {
    return [`${at}: слова схемы вне подмножества: ${unknown}`];
  }
  if (typeof node.$ref === "string") {
    const name = node.$ref.replace("#/$defs/", "");
    const defs = root.$defs as Record<string, Node | undefined>;
    const named = defs[name];
    if (named === undefined) return [`${at}: нет определения ${name}`];
    return violations(root, named, value, at);
  }
  const found: string[] = [];
  if (node.type !== undefined) {
    const types = [node.type].flat() as string[];
    if (!types.some((type) => fits(type, value))) {
      return [`${at}: ожидался ${types.join("|")}, пришёл ${typeOf(value)}`];
    }
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    found.push(
      `${at}: ${JSON.stringify(value)} не из ${JSON.stringify(node.enum)}`,
    );
  }
  if (typeof node.pattern === "string" && typeof value === "string") {
    if (!new RegExp(node.pattern, "u").test(value)) {
      found.push(`${at}: ${JSON.stringify(value)} не по ${node.pattern}`);
    }
  }
  if (Array.isArray(node.oneOf)) {
    const matched = (node.oneOf as Node[]).filter(
      (one) => violations(root, one, value, at).length === 0,
    );
    if (matched.length !== 1) {
      found.push(`${at}: oneOf совпал ${matched.length} раз`);
    }
  }
  if (Array.isArray(value) && node.items !== undefined) {
    value.forEach((item, i) =>
      found.push(...violations(root, node.items as Node, item, `${at}[${i}]`)),
    );
  }
  if (typeOf(value) === "object") {
    found.push(...objectViolations(root, node, value as Node, at));
  }
  return found;
}

function objectViolations(
  root: Node,
  node: Node,
  value: Node,
  at: string,
): string[] {
  const found: string[] = [];
  const properties = (node.properties ?? {}) as Record<string, Node>;
  for (const name of (node.required ?? []) as string[]) {
    if (!(name in value)) found.push(`${at}: нет обязательного ${name}`);
  }
  for (const [name, field] of Object.entries(value)) {
    const schema = properties[name];
    if (schema !== undefined) {
      found.push(...violations(root, schema, field, `${at}.${name}`));
    } else if (node.additionalProperties === false) {
      found.push(`${at}: лишнее поле ${name}`);
    }
  }
  return found;
}
