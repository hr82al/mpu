/**
 * Виды данных и отбор (`platform/collection-protocol.md`): коллекция,
 * запись, скаляр. Отбор — их сообщения; понимает ли сообщение, решает
 * вид. Вызовы отбора — слова в стороне: правила решают по пути команды,
 * а не по тому, что из её результата выбрано.
 */

import { GRAMMAR } from "../messages/mod.ts";
import { Help, OBJECT_VIEW } from "./help.ts";
import { AsideCall, Description } from "./method.ts";
import { nearest, order } from "./nearest.ts";
import type {
  Args,
  Call,
  Doc,
  MessageLine,
  Named,
  Outcome,
  Receiver,
  Reflection,
  Report,
  ResultKind,
  Sent,
  Shown,
} from "./protocol.ts";
import { reflected, sorted, withProtocol } from "./reflection.ts";
import { Refusal } from "./refusal.ts";
import { NO_REMEDY } from "./remedy.ts";
import { DATA_FORMATS, jsonText, PRINTED, type ResultEnd } from "./result.ts";
import { SILENT } from "./silent.ts";

/** Данные результата: приёмник отбора и то, что печатается. */
export interface Data extends Receiver, Shown {
  /** Значение поля `name`: у записи — поле, у прочих — отказ. */
  field(name: string): Data;
  /** Значение для сравнения: у скаляра — он сам, у прочих — `nil`. */
  comparable(): Comparable;
  /** Элемент в построчном виде коллекции. */
  line(): string;
  /**
   * Данные как результат команды без объявленной коллекции: запись с
   * одним полем-скаляром — этот скаляр, прочее — как есть.
   */
  asResult(): Data;
  /** Поле `row` — единственное: скаляр встаёт вместо записи, прочее — нет. */
  standIn(row: Data): Data;
}

/** Значение, которое сравнивают `where:` и `sortBy:`. */
interface Comparable {
  /** Равно ли значение тексту `text`. */
  is(text: string): boolean;
  /** Порядок относительно текста: < 0 — меньше; несравнимо — `NaN`. */
  compare(text: string): number;
  /** Содержит ли текст значения `text` без учёта регистра. */
  includes(text: string): boolean;
  /** Порядок сортировки: < 0 — это раньше `other`; `nil` — в конце. */
  order(other: Comparable): number;
  /** Порядок сортировки относительно скаляра с текстом `text`. */
  orderTo(text: string): number;
  /** Порядок сортировки относительно `nil`. */
  orderToNil(): number;
}

/** Как коллекция выглядит текстом: вид её источника. */
export interface ListView {
  text(items: readonly Data[]): string;
}

/** Построчно: элемент на строку. */
const LINES: ListView = {
  text: (items) => items.map((item) => `${item.line()}\n`).join(""),
};

/** Сообщение отбора: как оно входит в разбор, в справку и в отражение. */
interface Selection {
  readonly selector: string;
  describe(into: Description): void;
  message(): MessageLine;
}

/** Унарное сообщение отбора. */
function unarySelection(selector: string, purpose: string): Selection {
  return {
    selector,
    describe: (into) => into.unary(selector),
    message: () => ({ selector, kind: "unary", purpose }),
  };
}

/**
 * Ключевое сообщение отбора. В списках — первым ключом, как всякое
 * ключевое (`where:` — одна строка на четыре сравнения).
 */
function keywordSelection(
  keys: readonly string[],
  purpose: string,
  listed = purpose,
): Selection {
  const kinds = Object.fromEntries(keys.map((key) => [key, "value" as const]));
  return {
    selector: [...keys].sort().map((key) => `${key}:`).join(""),
    describe: (into) => into.keyword({ keys: kinds, required: [...keys] }),
    message: () => ({
      selector: `${keys[0]}:`,
      kind: "keyword",
      purpose: listed,
    }),
  };
}

const WHERE_PURPOSE = "записи по полю: is:, less:, greater: или includes:";

/** Сообщения отбора коллекции (`collection-protocol.md`, «Сообщения»). */
const SELECTIONS: readonly Selection[] = [
  unarySelection("size", "число элементов"),
  unarySelection("isEmpty", "пуста ли коллекция"),
  unarySelection("first", "первый элемент; пустая — nil"),
  unarySelection("last", "последний элемент; пустая — nil"),
  keywordSelection(["first"], "коллекция первых n элементов"),
  keywordSelection(["pick"], "значения поля у каждой записи"),
  keywordSelection(["sortBy"], "по возрастанию поля; nil — в конце"),
  ...[
    ["is", "записи с полем, равным значению"],
    ["less", "записи с полем меньше значения"],
    ["greater", "записи с полем больше значения"],
    ["includes", "записи, чьё поле содержит текст"],
  ].map(([key, purpose]) =>
    keywordSelection(["where", key], purpose, WHERE_PURPOSE)
  ),
];

/**
 * Сообщения отбора в списках: по одной строке на селектор. Их понимает
 * результат любого узла — снимок дерева несёт их одним списком.
 */
export function selectionMessages(): MessageLine[] {
  const lines = new Map<string, MessageLine>();
  for (const selection of SELECTIONS) {
    const line = selection.message();
    lines.set(line.selector, line);
  }
  return [...lines.values()];
}

const FORMAT_DOC: Doc = {
  purpose: "отобранное как JSON",
  help: "Данные отобранного JSON: коллекция — массив записей.",
};

const SAME_DOC: Doc = {
  purpose: "те же данные",
  help: `Закрытие данные не меняет: слово после ${GRAMMAR.close} — им же.`,
};

/** Отражение данных: сообщения вида и формат `json`. */
function dataReflection(messages: readonly MessageLine[]): Reflection {
  return {
    ...SILENT,
    messages: () => sorted(messages),
    formats: () => [...DATA_FORMATS],
    understands: (selector) =>
      DATA_FORMATS.includes(selector) ||
      messages.some((line) => line.selector === selector),
  };
}

/** Вид «данные после отбора»: до исполнения неизвестно, какие именно. */
const SELECTED: ResultKind = {
  parsing: () => {
    const into = new Description();
    for (const format of DATA_FORMATS) into.unary(format);
    for (const selection of SELECTIONS) selection.describe(into);
    return withProtocol(into).build();
  },
  about: (path, doc) =>
    new Help({
      path,
      purpose: doc.purpose,
      text: doc.help,
      examples: [],
      keys: [],
      formats: [...DATA_FORMATS],
      messages: selectionMessages(),
    }, OBJECT_VIEW),
  remedy: () => NO_REMEDY,
  reflect: () => dataReflection(selectionMessages()),
};

/** Сообщение данным: формат, закрытие, протокол, своё — или отказ. */
function lookupData(
  data: Data,
  sent: Sent,
  reflection: Reflection,
  own: (named: Named) => Data,
): Call {
  return sent.route({
    named: (named) =>
      format(data, named) ?? reflected(named, reflection) ??
        new AsideCall(named.text(), SAME_DOC, SELECTED, () => own(named)),
    tail: () => {
      throw new Refusal(`не понимает ${sent.selector()}`);
    },
    close: () => new AsideCall(GRAMMAR.close, SAME_DOC, SELECTED, () => data),
  });
}

/** Формат данных — `json`; прочее слово — не формат. */
function format(data: Data, named: Named): Call | undefined {
  if (!DATA_FORMATS.includes(named.selector())) return undefined;
  const json = new JsonOf(data);
  return new AsideCall(named.text(), FORMAT_DOC, SELECTED, () => json);
}

/** Отобранное JSON-ом: формат — последнее слово, дальше только `end`. */
class JsonOf implements Receiver {
  readonly #item: Shown;

  constructor(item: Shown) {
    this.#item = item;
  }

  lookup(sent: Sent): Call {
    return sent.route({
      named: () => formatLast(sent),
      tail: () => formatLast(sent),
      close: () => new AsideCall(GRAMMAR.close, SAME_DOC, SELECTED, () => this),
    });
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.value(jsonText(this.#item.data())));
  }
}

/** Слово после формата: формат — последним. */
function formatLast(sent: Sent): never {
  throw new Refusal(`не понимает ${sent.selector()}; формат — последним`);
}

/**
 * Отказ вида `kind` слову `selector` с ближайшими из `known`; близких
 * нет — называются `otherwise`.
 */
function notUnderstood(
  kind: string,
  selector: string,
  known: readonly string[],
  otherwise: readonly string[] = [],
): never {
  const close = nearest(selector, known);
  const shown = close.length > 0 ? close : otherwise;
  const hint = shown.length > 0 ? `; ближайшие: ${shown.join(", ")}` : "";
  throw new Refusal(`${kind} не понимает ${selector}${hint}`);
}

/** Числа — как числа, прочее — как текст (даты ISO сравниваются верно). */
function ordered(a: string, b: string): number {
  const x = numberOf(a);
  const y = numberOf(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return order(a, b);
  return x - y;
}

/** Число из текста; не число или пусто — `NaN`. */
function numberOf(text: string): number {
  return text.trim() === "" ? NaN : Number(text);
}

/** Текст значения ключа отбора. */
function argOf(args: Args, key: string): string {
  return String(args[key]);
}

/** Скаляр в поле или в коллекции: текст, число, булево. */
type Plain = string | number | boolean;

/** Скаляр: только форматы и протокол отражения. */
class Scalar implements Data, Comparable {
  readonly #value: Plain;

  constructor(value: Plain) {
    this.#value = value;
  }

  lookup(sent: Sent): Call {
    return lookupData(
      this,
      sent,
      dataReflection([]),
      (named) => notUnderstood("скаляр", named.selector(), []),
    );
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.shown(this));
  }

  field(name: string): Data {
    return notUnderstood("скаляр", name, []);
  }

  comparable(): Comparable {
    return this;
  }

  is(text: string): boolean {
    return this.line() === text;
  }

  compare(text: string): number {
    return ordered(this.line(), text);
  }

  includes(text: string): boolean {
    return this.line().toLowerCase().includes(text.toLowerCase());
  }

  order(other: Comparable): number {
    return -other.orderTo(this.line());
  }

  orderTo(text: string): number {
    return ordered(this.line(), text);
  }

  orderToNil(): number {
    return -1;
  }

  text(): string {
    return `${this.line()}\n`;
  }

  data(): Plain {
    return this.#value;
  }

  asResult(): Data {
    return this;
  }

  standIn(): Data {
    return this;
  }

  line(): string {
    return String(this.#value);
  }
}

/**
 * `nil`: нет значения — пустой коллекции `first`, `null` в данных.
 * Печатается пустой строкой, в JSON — `null`; ни с чем не совпадает и
 * при сортировке идёт в конец. Единственный null-объект модуля: им же
 * сравниваются запись и коллекция.
 */
const NIL: Data & Comparable = {
  lookup: (sent) =>
    lookupData(
      NIL,
      sent,
      dataReflection([]),
      (named) => notUnderstood("скаляр", named.selector(), []),
    ),
  final: (report) => Promise.resolve(report.shown(NIL)),
  field: (name) => notUnderstood("скаляр", name, []),
  comparable: () => NIL,
  is: () => false,
  compare: () => NaN,
  includes: () => false,
  order: (other) => -other.orderToNil(),
  orderTo: () => 1,
  orderToNil: () => 0,
  text: () => "\n",
  data: () => null,
  line: () => "",
  asResult: () => NIL,
  // `null` — не скаляр значения ключа (161): запись остаётся записью.
  standIn: (row) => row,
};

/** Методы коллекции: селектор → что она отдаёт. */
const COLLECTION_METHODS: ReadonlyMap<
  string,
  (items: Collection, args: Args) => Data
> = new Map<string, (items: Collection, args: Args) => Data>([
  ["size", (items) => items.size()],
  ["isEmpty", (items) => items.isEmpty()],
  ["first", (items) => items.at(0)],
  ["last", (items) => items.at(-1)],
  ["first:", (items, args) => items.head(argOf(args, "first"))],
  ["pick:", (items, args) => items.pick(argOf(args, "pick"))],
  ["sortBy:", (items, args) => items.sortBy(argOf(args, "sortBy"))],
  [
    "is:where:",
    (items, args) => items.where(args, (value) => value.is(argOf(args, "is"))),
  ],
  [
    "less:where:",
    (items, args) =>
      items.where(args, (value) => value.compare(argOf(args, "less")) < 0),
  ],
  [
    "greater:where:",
    (items, args) =>
      items.where(args, (value) => value.compare(argOf(args, "greater")) > 0),
  ],
  [
    "includes:where:",
    (items, args) =>
      items.where(args, (value) => value.includes(argOf(args, "includes"))),
  ],
]);

/** Коллекция: элементы по порядку и вид её текста. */
class Collection implements Data {
  readonly #items: readonly Data[];
  readonly #view: ListView;

  constructor(items: readonly Data[], view: ListView) {
    this.#items = items;
    this.#view = view;
  }

  lookup(sent: Sent): Call {
    const messages = selectionMessages();
    return lookupData(this, sent, dataReflection(messages), (named) => {
      const method = COLLECTION_METHODS.get(named.selector());
      if (method !== undefined) return method(this, named.args());
      return notUnderstood(
        "коллекция",
        named.selector(),
        messages.map((line) => line.selector),
      );
    });
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.shown(this));
  }

  size(): Data {
    return new Scalar(this.#items.length);
  }

  isEmpty(): Data {
    return new Scalar(this.#items.length === 0);
  }

  /** Элемент по месту (`-1` — последний); нет такого — `nil`. */
  at(index: number): Data {
    return this.#items.at(index) ?? NIL;
  }

  /** Первые `count` элементов; `count` — целое ≥ 0 текстом. */
  head(count: string): Data {
    if (!/^\d+$/.test(count)) {
      throw new Refusal(`first: ${count} — ожидается n ≥ 0`);
    }
    return this.#with(this.#items.slice(0, Number(count)));
  }

  /** Значения поля у каждого элемента: вид — построчный. */
  pick(name: string): Data {
    return new Collection(this.#items.map((item) => item.field(name)), LINES);
  }

  /** Элементы, у которых поле `where:` проходит проверку `test`. */
  where(args: Args, test: (value: Comparable) => boolean): Data {
    const name = argOf(args, "where");
    return this.#with(
      this.#items.filter((item) => test(item.field(name).comparable())),
    );
  }

  /** По возрастанию поля; порядок равных — прежний. */
  sortBy(name: string): Data {
    const keyed = this.#items.map((item) => ({
      item,
      key: item.field(name).comparable(),
    }));
    keyed.sort((a, b) => a.key.order(b.key));
    return this.#with(keyed.map(({ item }) => item));
  }

  /** Та же коллекция с другими элементами: вид — прежний. */
  #with(items: readonly Data[]): Collection {
    return new Collection(items, this.#view);
  }

  field(name: string): Data {
    return notUnderstood("коллекция", name, []);
  }

  comparable(): Comparable {
    return NIL;
  }

  text(): string {
    return this.#view.text(this.#items);
  }

  data(): unknown[] {
    return this.#items.map((item) => item.data());
  }

  asResult(): Data {
    return this;
  }

  standIn(row: Data): Data {
    return row;
  }

  line(): string {
    return JSON.stringify(this.data());
  }
}

/** Селектор, который запись читает как имя поля, совпади оно с протоколом. */
const PICK = "pick:";

/** Запись: поля по имени. */
class Row implements Data {
  readonly #fields: Readonly<{ [name: string]: unknown }>;

  constructor(fields: Readonly<{ [name: string]: unknown }>) {
    this.#fields = fields;
  }

  lookup(sent: Sent): Call {
    const messages: MessageLine[] = [
      ...Object.keys(this.#fields).map((name): MessageLine => ({
        selector: name,
        kind: "unary",
        purpose: "поле записи",
      })),
      { selector: PICK, kind: "keyword", purpose: "поле по имени" },
    ];
    return lookupData(this, sent, dataReflection(messages), (named) => {
      if (named.selector() === PICK) {
        return this.field(argOf(named.args(), "pick"));
      }
      return this.field(named.selector());
    });
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.shown(this));
  }

  field(name: string): Data {
    if (!Object.hasOwn(this.#fields, name)) {
      // Близкого поля нет — называются все: иначе ошибку не исправить.
      const names = Object.keys(this.#fields);
      return notUnderstood("запись", name, names, names);
    }
    return dataOf(this.#fields[name]);
  }

  comparable(): Comparable {
    return NIL;
  }

  /** Поле на строку: `имя\tзначение`. */
  text(): string {
    return Object.keys(this.#fields)
      .map((name) => `${name}\t${this.field(name).line()}\n`)
      .join("");
  }

  data(): unknown {
    return this.#fields;
  }

  asResult(): Data {
    const names = Object.keys(this.#fields);
    return names.length === 1 ? this.field(names[0]).standIn(this) : this;
  }

  standIn(row: Data): Data {
    return row;
  }

  line(): string {
    return JSON.stringify(this.#fields);
  }
}

/**
 * Данные из JSON (граница): список — коллекция, объект — запись, `null`
 * — `nil`, прочее — скаляр.
 */
export function dataOf(value: unknown): Data {
  if (value === null || value === undefined) return NIL;
  if (Array.isArray(value)) {
    return new Collection(value.map((item) => dataOf(item)), LINES);
  }
  if (typeof value === "object") {
    // Объект JSON — поля по имени: сужение `typeof` ключей не называет.
    return new Row(value as { [name: string]: unknown });
  }
  const plain = typeof value === "number" || typeof value === "boolean";
  return new Scalar(plain ? value : String(value));
}

/**
 * Результат, у которого коллекции не объявлено: запись ровно с одним
 * полем-скаляром — этот скаляр, как значение ключа
 * (`platform/value-expression.md`); прочее — как данные JSON.
 */
export function resultData(value: unknown): Data {
  return dataOf(value).asResult();
}

/**
 * Коллекция записей результата с видом команды.
 *
 * @param records записи, как их отдала команда
 * @param view текст коллекции — вид команды над подменёнными записями
 */
export function collectionOf(
  records: readonly unknown[],
  view: ListView,
): Data {
  return new Collection(records.map((record) => dataOf(record)), view);
}

/** Откуда отбор берёт данные — в конце строки, один раз. */
export interface Source {
  /**
   * Данные — отбору `replay`; до данных не дошло (отказ, код) — итог
   * как есть.
   */
  select(
    report: Report,
    replay: (data: Data) => Promise<Outcome>,
  ): Promise<Outcome>;
}

/** Итог, в котором у данных со своим видом берутся данные. */
function dataReport(report: Report): Report {
  return {
    value: (data) => report.value(data),
    shown: (item) => report.value(item.data()),
    object: () => report.object(),
    exit: (code) => report.exit(code),
    links: () => report.links(),
    text: () => report.text(),
    through: (gate) => report.through(gate),
  };
}

/** Данные, которые приёмник отдал бы в конце строки. */
export class Ended implements Source {
  readonly #receiver: Receiver;

  constructor(receiver: Receiver) {
    this.#receiver = receiver;
  }

  async select(
    report: Report,
    replay: (data: Data) => Promise<Outcome>,
  ): Promise<Outcome> {
    const outcome = await this.#receiver.final(dataReport(report));
    // Итог — данные границы: отказ и код данных не несут.
    if (!("value" in outcome)) return outcome;
    return await replay(resultData(outcome.value));
  }
}

const SELECT_DOC: Doc = {
  purpose: "отбор из результата",
  help: "Сообщение данным результата: исполняется, когда результат готов.",
};

/**
 * Отбор, пока строка не кончилась: сообщения копятся и проигрываются над
 * данными источника, когда они готовы, — источник исполняется один раз.
 */
class Selecting implements Receiver {
  readonly #source: Source;
  readonly #sents: readonly Sent[];

  constructor(source: Source, sents: readonly Sent[]) {
    this.#source = source;
    this.#sents = sents;
  }

  lookup(sent: Sent): Call {
    const next = () => new Selecting(this.#source, [...this.#sents, sent]);
    // Протокол отражения — о виде, без исполнения: как справка.
    return sent.route({
      named: (named) =>
        reflected(named, SELECTED.reflect()) ??
          new AsideCall(named.text(), SELECT_DOC, SELECTED, next),
      tail: () => {
        throw new Refusal(`не понимает ${sent.selector()}`);
      },
      close: () => new AsideCall(GRAMMAR.close, SELECT_DOC, SELECTED, next),
    });
  }

  final(report: Report): Promise<Outcome> {
    return this.#source.select(report, (data) => this.#replay(data, report));
  }

  async #replay(data: Data, report: Report): Promise<Outcome> {
    let receiver: Receiver = data;
    for (const sent of this.#sents) {
      receiver = await receiver.lookup(sent).perform();
    }
    return await receiver.final(report);
  }
}

/**
 * Первое сообщение отбора: дальше строка копится до конца.
 *
 * @param source откуда данные
 * @param named сообщение отбора
 */
export function selecting(source: Source, named: Named): Call {
  return new AsideCall(
    named.text(),
    SELECT_DOC,
    SELECTED,
    () => new Selecting(source, [named]),
  );
}

/**
 * Вид результата вместе с сообщениями отбора: разбор, справка и
 * отражение называют и его сообщения, и отбор.
 *
 * @param kind вид результата без отбора (форматы)
 */
export function selectable(kind: ResultKind): ResultKind {
  const messages = () =>
    sorted([...kind.reflect().messages(), ...selectionMessages()]);
  return {
    parsing: () => {
      const own = kind.parsing();
      const into = new Description();
      for (const selector of own.unary) into.unary(selector);
      for (const method of own.keyword) into.keyword(method);
      for (const selection of SELECTIONS) selection.describe(into);
      return into.build();
    },
    about: (path, doc) => {
      const help = kind.about(path, doc).data();
      return new Help({ ...help, messages: messages() }, OBJECT_VIEW);
    },
    remedy: (word, after) => kind.remedy(word, after),
    reflect: () => ({
      ...kind.reflect(),
      messages,
      understands: (selector) =>
        kind.reflect().understands(selector) ||
        selectionMessages().some((line) => line.selector === selector),
    }),
  };
}

/** Вид результата после закрытия: форматы и сообщения отбора. */
const ENDED: ResultKind = selectable(PRINTED);

/**
 * Сообщение результату, который понимает отбор: протокол отражения —
 * видом, без исполнения; отбор — от источника `source`; прочее —
 * `otherwise`.
 *
 * @param source источник отбора; спрашивается, только если это отбор
 */
export function selectionOf(
  named: Named,
  kind: ResultKind,
  source: () => Source,
  otherwise: () => Call,
): Call {
  const protocol = reflected(named, kind.reflect());
  if (protocol !== undefined) return protocol;
  return isSelection(named.selector())
    ? selecting(source(), named)
    : otherwise();
}

/** Сообщение отбора ли селектор `selector`. */
export function isSelection(selector: string): boolean {
  return SELECTIONS.some((one) => one.selector === selector);
}

/** Результат, который понимает отбор: слово не формат — начало отбора. */
export const SELECTABLE: ResultEnd = {
  kind: ENDED,
  selects: (inner, named) =>
    reflected(named, ENDED.reflect()) ??
      selecting(new Ended(inner), named),
};
