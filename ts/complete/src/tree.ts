/**
 * Дерево дополнения из снимка `mpu-back` (`specs/complete.md`): узел с
 * хвостом и без, «после аргумента» и «нигде» отвечают на «шаг» и
 * «варианты для слова» по-своему. JSON снимка разбирается здесь, на
 * границе; дальше — только узлы.
 */

/** Вариант дополнения. */
export interface Choice {
  readonly value: string;
  readonly summary: string;
}

/** Узел дерева глазами дополнения. */
export interface Place {
  /** Узел после слова `word` строки. */
  step(word: string): Place;
  /** Варианты для дописываемого слова (без отбора по префиксу). */
  choices(word: string): readonly Choice[];
}

/** `--help` предлагается везде, где ждут флаг. */
const HELP: Choice = { value: "--help", summary: "справка" };

function flagLike(word: string): boolean {
  return word.startsWith("-");
}

/** Пути нет или снимка нет: вариантов нет, дальше — тоже нигде. */
export const NOWHERE: Place = {
  step: () => NOWHERE,
  choices: () => [],
};

/** Узел из снимка: селекторы с назначениями и флаги. */
interface Known {
  readonly selectors: readonly Choice[];
  readonly flags: readonly Choice[];
  /** Узел селектора; не селектор этого узла — `otherwise`. */
  child(selector: string, otherwise: Place): Place;
}

/** Группа без хвоста: слово — селектор; флагов своих нет. */
class Group implements Place {
  readonly #node: Known;

  constructor(node: Known) {
    this.#node = node;
  }

  step(word: string): Place {
    return this.#node.child(word, NOWHERE);
  }

  choices(word: string): readonly Choice[] {
    return flagLike(word) ? [HELP] : this.#node.selectors;
  }
}

/** Узел с хвостом: селектор — дальше, прочее слово — уже аргумент. */
class Tailed implements Place {
  readonly #node: Known;

  constructor(node: Known) {
    this.#node = node;
  }

  step(word: string): Place {
    return this.#node.child(word, new Args(this.#node));
  }

  choices(word: string): readonly Choice[] {
    return flagLike(word) ? [...this.#node.flags, HELP] : this.#node.selectors;
  }
}

/** После аргумента: значения не дополняются, только флаги. */
class Args implements Place {
  readonly #node: Known;

  constructor(node: Known) {
    this.#node = node;
  }

  step(): Place {
    return this;
  }

  choices(word: string): readonly Choice[] {
    return flagLike(word) ? [...this.#node.flags, HELP] : [];
  }
}

/** Узел снимка как данные (граница контракта). */
interface RawNode {
  readonly path: readonly string[];
  readonly summary: string;
  readonly selectors: readonly string[];
  readonly tail: string | null;
  readonly flags: readonly {
    readonly name: string;
    readonly summary: string;
  }[];
  readonly summaries: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string");
}

/** Узел снимка; не по контракту — `undefined`. */
function rawNode(value: unknown): RawNode | undefined {
  if (!isRecord(value)) return undefined;
  const { path, summary, selectors, tail, flags = [], summaries = {} } = value;
  if (!strings(path) || !strings(selectors) || typeof summary !== "string") {
    return undefined;
  }
  if (tail !== null && typeof tail !== "string") return undefined;
  if (!Array.isArray(flags) || !isRecord(summaries)) return undefined;
  const choices = flags.filter((flag): flag is RawNode["flags"][number] =>
    isRecord(flag) && typeof flag.name === "string" &&
    typeof flag.summary === "string"
  );
  const texts: Record<string, string> = {};
  for (const [selector, text] of Object.entries(summaries)) {
    if (typeof text === "string") texts[selector] = text;
  }
  return { path, summary, selectors, tail, flags: choices, summaries: texts };
}

const key = (path: readonly string[]) => JSON.stringify(path);

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
  const raws = new Map<string, RawNode>();
  for (const value of body.nodes) {
    const raw = rawNode(value);
    if (raw !== undefined) raws.set(key(raw.path), raw);
  }
  const places = new Map<string, Place>();
  const placeAt = (path: readonly string[]): Place => {
    const found = places.get(key(path));
    if (found !== undefined) return found;
    const raw = raws.get(key(path));
    if (raw === undefined) return NOWHERE;
    const known: Known = {
      selectors: raw.selectors.map((selector) => ({
        value: selector,
        summary: raws.get(key([...path, selector]))?.summary ??
          raw.summaries[selector] ?? "",
      })),
      flags: raw.flags.map((flag) => ({
        value: flag.name,
        summary: flag.summary,
      })),
      child: (selector, otherwise) =>
        raw.selectors.includes(selector)
          ? placeAt([...path, selector])
          : otherwise,
    };
    const place = raw.tail === null ? new Group(known) : new Tailed(known);
    places.set(key(path), place);
    return place;
  };
  return placeAt([]);
}
