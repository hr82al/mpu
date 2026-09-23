/**
 * Варианты команды (`platform/variants.md`): флаг поведения стал унарным
 * сообщением объекту команды до ключей — `mpu process dry target: 54`.
 * Вариант выводится из входа команды каталогом ключей (`keys.ts`); здесь —
 * сам вариант, набор выбранных и метод листа, который его принимает.
 */

import {
  type Call,
  callLine,
  type Description,
  type Doc,
  type Help,
  type Named,
  type Receiver,
  Refusal,
  ROOT_TEXT,
  type Shape,
  type Trace,
  type VariantLine,
  type VariantMethod as VariantMethodOf,
} from "../objects/mod.ts";

/** Вариант команды: слово, назначение и вход, который он задаёт. */
export class Variant {
  readonly name: string;
  readonly purpose: string;
  /** Вход команды, который задаёт вариант. */
  readonly input: string;
  /** Слова варианта в строке прежней диспетчеризации: `--dry-run`. */
  readonly #options: readonly string[];

  constructor(
    name: string,
    purpose: string,
    input: string,
    options: readonly string[],
  ) {
    this.name = name;
    this.purpose = purpose;
    this.input = input;
    this.#options = options;
  }

  /** Кладёт свой вход в опции строки прежней диспетчеризации. */
  place(options: string[]) {
    options.push(...this.#options);
  }
}

/** Выбранные варианты строки — по порядку набора. */
export class Chosen {
  readonly #variants: readonly Variant[];

  constructor(variants: readonly Variant[]) {
    this.#variants = variants;
  }

  /** Тот же набор и ещё один вариант. */
  with(variant: Variant): Chosen {
    return new Chosen([...this.#variants, variant]);
  }

  /** Можно ли выбрать вариант: его вход ещё не задан другим. */
  offers(variant: Variant): boolean {
    return !this.#variants.some((one) => one.input === variant.input);
  }

  /** Кладёт выбранные в опции строки прежней диспетчеризации. */
  place(options: string[]) {
    for (const variant of this.#variants) variant.place(options);
  }

  /**
   * Готовая строка команды `path` с этими вариантами, ещё одним словом
   * `extra` и ключами `pairs` — для подсказки отказа.
   */
  line(
    path: readonly string[],
    extra: readonly string[],
    pairs: readonly string[],
  ): string {
    const names = this.#variants.map((variant) => variant.name);
    return callLine(ROOT_TEXT, [...path, ...names, ...extra, ...pairs]);
  }
}

/** Вариантов не выбрано. Единственный null-объект набора. */
export const NONE_CHOSEN = new Chosen([]);

/**
 * Слово за ключами, которое результат строки не понял: если это вариант
 * команды — отказ «вариант — до ключей» с готовой строкой.
 */
export interface Misplaced {
  check(word: string): void;
}

/** Каталога вариантов у строки нет: проверять нечего. */
export const NOT_MISPLACED: Misplaced = { check() {} };

/** Слова строки ключевой команды: варианты её каталога и набранные ключи. */
export class MisplacedVariants implements Misplaced {
  readonly #path: readonly string[];
  readonly #names: ReadonlySet<string>;
  readonly #chosen: Chosen;
  readonly #pairs: readonly string[];

  /**
   * @param path путь команды
   * @param names имена всех вариантов команды
   * @param chosen варианты, уже набранные до ключей
   * @param pairs ключи строки, как их набрали
   */
  constructor(
    path: readonly string[],
    names: readonly string[],
    chosen: Chosen,
    pairs: readonly string[],
  ) {
    this.#path = path;
    this.#names = new Set(names);
    this.#chosen = chosen;
    this.#pairs = pairs;
  }

  check(word: string) {
    if (!this.#names.has(word)) return;
    const line = this.#chosen.line(this.#path, [word], this.#pairs);
    throw new Refusal(`вариант — до ключей: ${line}`);
  }
}

/**
 * Метод листа — вариант: слово пишется в адрес и текст вопроса, но не в
 * звенья правил; ответ — лист той же команды с этим вариантом. Лист
 * строится при связывании: набор вариантов у каждой строки свой, и
 * заранее все сочетания не собираются.
 */
export class VariantMethod<S> implements VariantMethodOf<S> {
  readonly selector: string;
  readonly #input: string;
  readonly #purpose: string;
  readonly #doc: Doc;
  readonly #leaf: () => Shape<S>;

  /**
   * @param variant вариант каталога
   * @param doc справка команды: её показывает лист с вариантом
   * @param leaf лист команды с этим вариантом
   */
  constructor(variant: Variant, doc: Doc, leaf: () => Shape<S>) {
    this.selector = variant.name;
    this.#input = variant.input;
    this.#purpose = variant.purpose;
    this.#doc = doc;
    this.#leaf = leaf;
  }

  describe(into: Description) {
    into.unary(this.selector);
  }

  line(): Pick<VariantLine, "selector" | "purpose"> {
    return { selector: this.selector, purpose: this.#purpose };
  }

  variant(): VariantLine {
    return { ...this.line(), input: this.#input };
  }

  bind(self: S, sent: Named): Call {
    return new VariantCall(sent.text(), this.#doc, this.#leaf(), self);
  }
}

/** Вызов варианта: без звена правил, ответ — лист с вариантом. */
class VariantCall<S> implements Call {
  readonly #text: string;
  readonly #doc: Doc;
  readonly #leaf: Shape<S>;
  readonly #self: S;

  constructor(text: string, doc: Doc, leaf: Shape<S>, self: S) {
    this.#text = text;
    this.#doc = doc;
    this.#leaf = leaf;
    this.#self = self;
  }

  trace(trail: Trace) {
    trail.unlinked(this.#text);
  }

  result(): Shape<S> {
    return this.#leaf;
  }

  help(trail: Trace): Help {
    return this.#leaf.about(trail.textWith(this.#text), this.#doc);
  }

  perform(): Promise<Receiver> {
    return Promise.resolve(this.#leaf.receive(this.#self));
  }
}
