/**
 * Дерево дополнения из снимка `mpu-back` (`platform/reflection.md`,
 * «mpu-complete»): снимок — вывод протокола отражения, у узла его
 * `messages`, `variants`, `keys`, `formats`. Место строки отвечает на «шаг» и
 * «варианты» по-своему; значений ключей снимок не знает. JSON снимка
 * разбирается здесь, на границе; дальше — только места.
 */

/** Вариант дополнения. */
export interface Choice {
  readonly value: string;
  readonly summary: string;
}

/** Место строки глазами дополнения. */
export interface Place {
  /** Место после слова `word` строки. */
  step(word: string): Place;
  /** Варианты для дописываемого слова (без отбора по префиксу). */
  choices(): readonly Choice[];
}

/** Слова грамматики строки (`platform/line-grammar.md`). */
const CLOSE = "end";
const LITERAL = "--";

/** Слова справки: путь они не меняют. */
const SKIPPED: ReadonlySet<string> = new Set(["help", "--help"]);

/** Пути нет или снимка нет: вариантов нет, дальше — тоже нигде. */
export const NOWHERE: Place = {
  step: () => NOWHERE,
  choices: () => [],
};

/** Ключ ключевого сообщения узла. */
interface Key {
  readonly name: string;
  readonly kind: string;
  readonly purpose: string;
}

/** Как ключ набирают: флаг — `--имя`, прочие — `имя:`. */
function spelled(key: Key): string {
  return key.kind === "flag" ? `--${key.name}` : `${key.name}:`;
}

/** Вариант узла: слово, назначение и вход, который он задаёт. */
interface Variant extends Choice {
  readonly input: string;
}

/** Узел снимка: его сообщения, варианты, ключи, слова результата и дети. */
interface Known {
  readonly messages: readonly Choice[];
  readonly variants: readonly Variant[];
  readonly keys: readonly Key[];
  /** Слова после закрытия: форматы узла и сообщения отбора. */
  readonly results: readonly Choice[];
  child(selector: string): Place | undefined;
}

/** Результат после закрытия: варианты — форматы и отбор, дальше — нигде. */
class Result implements Place {
  readonly #words: readonly Choice[];

  constructor(words: readonly Choice[]) {
    this.#words = words;
  }

  step(): Place {
    return NOWHERE;
  }

  choices(): readonly Choice[] {
    return this.#words;
  }
}

/** Знак литерала: следующее слово — значение, дописывать нечего. */
class Literal implements Place {
  readonly #after: Place;

  constructor(after: Place) {
    this.#after = after;
  }

  step(): Place {
    return this.#after;
  }

  choices(): readonly Choice[] {
    return [];
  }
}

/** Ключевое сообщение узла: набранные ключи и ждёт ли ключ значения. */
class Keyword implements Place {
  readonly #node: Known;
  readonly #typed: readonly string[];
  readonly #waiting: boolean;

  constructor(node: Known, typed: readonly string[], waiting: boolean) {
    this.#node = node;
    this.#typed = typed;
    this.#waiting = waiting;
  }

  step(word: string): Place {
    if (this.#waiting) return new Keyword(this.#node, this.#typed, false);
    if (word === CLOSE) return new Result(this.#node.results);
    if (word === LITERAL) return new Literal(this);
    const key = this.#node.keys.find((one) => spelled(one) === word);
    if (key === undefined) return NOWHERE;
    return new Keyword(
      this.#node,
      [...this.#typed, key.name],
      key.kind !== "flag",
    );
  }

  choices(): readonly Choice[] {
    if (this.#waiting) return [];
    return this.#node.keys
      .filter((key) => !this.#typed.includes(key.name) || key.kind === "list")
      .map((key) => ({ value: spelled(key), summary: key.purpose }));
  }
}

/**
 * Узел дерева: слово — сообщение, вариант, ключ, закрытие или литерал.
 * Выбранный вариант исключает варианты своего входа, как у `back`.
 */
class Node implements Place {
  readonly #node: Known;

  constructor(node: Known) {
    this.#node = node;
  }

  step(word: string): Place {
    if (SKIPPED.has(word)) return this;
    if (word === CLOSE) return new Result(this.#node.results);
    if (word === LITERAL) return new Literal(NOWHERE);
    const child = this.#node.child(word);
    if (child !== undefined) return child;
    const variant = this.#node.variants.find((one) => one.value === word);
    if (variant !== undefined) {
      const variants = this.#node.variants
        .filter((one) => one.input !== variant.input);
      return new Node({ ...this.#node, variants });
    }
    return new Keyword(this.#node, [], false).step(word);
  }

  choices(): readonly Choice[] {
    return [...this.#node.messages, ...this.#node.variants]
      .map(({ value, summary }) => ({ value, summary }))
      .sort(byValue);
  }
}

/** Порядок слов дополнения — по алфавиту, как у `back`. */
function byValue(a: Choice, b: Choice): number {
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

/** Узел снимка как данные (граница контракта). */
interface RawNode {
  readonly path: readonly string[];
  readonly summary: string;
  readonly messages: readonly {
    readonly selector: string;
    readonly kind: string;
    readonly purpose: string;
  }[];
  readonly keys: readonly Key[];
  readonly formats: readonly string[];
  readonly variants: readonly {
    readonly selector: string;
    readonly purpose: string;
    readonly input: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

/** Записи со строковыми полями `fields`; прочие отбрасываются. */
function records<K extends string>(
  value: unknown,
  fields: readonly K[],
): Record<K, string>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<K, string> =>
    isRecord(item) && fields.every((field) => typeof item[field] === "string")
  );
}

/** Узел снимка; не по контракту — `undefined`. */
function rawNode(value: unknown): RawNode | undefined {
  if (!isRecord(value)) return undefined;
  const { path, summary, messages, keys, formats = [], variants } = value;
  if (!strings(path) || typeof summary !== "string" || !strings(formats)) {
    return undefined;
  }
  return {
    path,
    summary,
    messages: records(messages, ["selector", "kind", "purpose"]),
    keys: records(keys, ["name", "kind", "purpose"]),
    formats,
    variants: records(variants, ["selector", "purpose", "input"]),
  };
}

const keyOf = (path: readonly string[]) => JSON.stringify(path);

/**
 * Корень дерева из текста снимка; не JSON, не по контракту, без корня —
 * `NOWHERE`.
 */
export function treeOf(text: string): Place {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Снимок не читается — дополнять нечем, это не ошибка дополнения.
    return NOWHERE;
  }
  if (!isRecord(body) || !Array.isArray(body.nodes)) return NOWHERE;
  // Отбор понимает результат любого узла: список в снимке один.
  const selection = records(body.selection, ["selector", "kind", "purpose"])
    .map((line) => ({ value: line.selector, summary: line.purpose }));
  const raws = new Map<string, RawNode>();
  for (const value of body.nodes) {
    const raw = rawNode(value);
    if (raw !== undefined) raws.set(keyOf(raw.path), raw);
  }
  const places = new Map<string, Place>();
  const placeAt = (path: readonly string[]): Place | undefined => {
    const found = places.get(keyOf(path));
    if (found !== undefined) return found;
    const raw = raws.get(keyOf(path));
    if (raw === undefined) return undefined;
    const unary = new Set(
      raw.messages.filter((line) => line.kind === "unary")
        .map((line) => line.selector),
    );
    const place = new Node({
      messages: raw.messages.map((line) => ({
        value: line.selector,
        summary: line.purpose,
      })),
      variants: raw.variants.map((line) => ({
        value: line.selector,
        summary: line.purpose,
        input: line.input,
      })),
      keys: raw.keys,
      results: [
        ...raw.formats.map((format) => ({ value: format, summary: "" })),
        ...selection,
      ].sort(byValue),
      child: (selector) =>
        unary.has(selector) ? placeAt([...path, selector]) : undefined,
    });
    places.set(keyOf(path), place);
    return place;
  };
  return placeAt([]) ?? NOWHERE;
}
