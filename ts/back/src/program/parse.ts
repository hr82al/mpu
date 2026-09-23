/**
 * Разбор программы (`platform/evaluator.md`, «Разбор»): слова → узлы.
 * Имена связываются по ходу разбора — голое слово в начале выражения
 * становится переменной, только если связано выше; иначе это сообщение
 * корню, то есть команда реестра, которую исполнит ядро. Отказы до
 * исполнения (код 2) — здесь.
 */

import { GRAMMAR } from "../messages/mod.ts";
import type { KeyKind } from "../messages/mod.ts";
import {
  nearest,
  notUnderstood,
  Refusal,
  substituted,
} from "../objects/mod.ts";
import { RESULT } from "./data.ts";
import { NUMBER } from "./lexis.ts";
import { Misstep, placed, type Span } from "./machine.ts";
import { Names } from "./names.ts";
import {
  AS_PRINTED,
  AS_VALUE,
  Assignment,
  Chain,
  Command,
  Computed,
  Constant,
  type Expression,
  Keyword,
  Known,
  type Message,
  type Part,
  Program,
  Statements,
  Unary,
  UNKNOWN,
  Variable,
  Written,
} from "./nodes.ts";
import { Num, selectorOf, Text } from "./objects.ts";
import { closerOf, textAt, unparsed } from "./scan.ts";
import type { CommandView } from "./data.ts";

/** Узел дерева команд глазами разбора (снимок дерева, граница). */
export interface CommandNode {
  /** Команда (лист) — да; группа — нет. */
  readonly leaf: boolean;
  /** Ключи команды: имя → вид; у группы — пусто. */
  readonly keys: ReadonlyMap<string, KeyKind>;
  /** Сообщения узла: дети группы — для ближайших к непонятому. */
  readonly messages: readonly string[];
  /** Форматы результата команды, `json` в их числе. */
  readonly formats: readonly string[];
  /**
   * Ключи, чей файл читается своим ключом: ключ → ключ файла
   * (`body` → `body-file`); `@путь` значением — отказ с готовой строкой.
   */
  readonly fromFile: ReadonlyMap<string, string>;
  /**
   * Звенья пути правила: по ним правила решают команду до исполнения
   * (`platform/ask-composite.md`); у команды с хвостом — со звеном `<args>`.
   */
  readonly links: readonly string[];
}

/** Дерево команд реестра: узлы для разбора, вид результата для печати. */
export interface Commands {
  /** Узел по пути; нет такого — `undefined`. */
  node(path: readonly string[]): CommandNode | undefined;
  /** Результат `result` команды `path`, вызванной с `argv`. */
  view(
    path: readonly string[],
    result: unknown,
    argv: readonly string[],
  ): CommandView;
}

/** Корень строки глазами разбора: что он понимает (двери, `it`, команды). */
export interface Root {
  /** Слово в начале выражения — сообщение корню, иначе отказ. */
  accepts(word: string): boolean;
  /** Имя занято сообщением корня: переменную так не назвать. */
  reserves(name: string): boolean;
  /** Сообщения корня — для ближайших к непонятому. */
  messages(): readonly string[];
}

/**
 * Корень, который не отказывает: разбор у исполнителя, после того как
 * ядро уже проверило строку своим корнем.
 */
export const LENIENT_ROOT: Root = {
  accepts: () => true,
  reserves: () => false,
  messages: () => [],
};

/** Слова грамматики: переменной так не назвать. */
const GRAMMAR_WORDS: ReadonlySet<string> = new Set(Object.values(GRAMMAR));

/** Слово — ключ ключевого сообщения: `id:`. */
function isKey(word: string): boolean {
  return word.length > 1 && word.endsWith(GRAMMAR.parameter) &&
    word !== GRAMMAR.assign;
}

/** Имя ключа слова в любой форме (`id:`, `--id`, `--id=1`); не ключ — `undefined`. */
function keyName(word: string): string | undefined {
  if (isKey(word)) return word.slice(0, -GRAMMAR.parameter.length);
  if (!word.startsWith("--") || word.length <= 2) return undefined;
  return word.slice(2).split("=")[0];
}

/** Голое слово: не ключ, не знак, не слово грамматики. */
function isPlain(word: string): boolean {
  return !GRAMMAR_WORDS.has(word) && !isKey(word) &&
    !/^[-^@:]/.test(word);
}

/** Слово, на котором значения нет: конец выражения или закрытие. */
function endsValue(word: string): boolean {
  return VALUE_ENDS.has(word);
}

const VALUE_ENDS: ReadonlySet<string> = new Set([
  GRAMMAR.separator,
  GRAMMAR.close,
  GRAMMAR.assign,
]);

/**
 * Слово, на котором кончается сегмент команды и унарные значения; `done`
 * здесь — закрыватель: литерал он только на месте значения.
 */
function stops(word: string): boolean {
  return endsValue(word) || word === GRAMMAR.blockEnd;
}

/** Вид первичного выражения: что проверить у первого ключевого за ним. */
interface Primary {
  readonly expression: Expression;
  /** Проверка остатка ключей, уходящего результату, — до исполнения. */
  check(keys: readonly string[], span: Span): void;
}

/** Первичное выражение, которое проверять нечего. */
function plain(expression: Expression): Primary {
  return { expression, check() {} };
}

/**
 * Разбор строки программы. Состояние — позиция, граница, имена и место
 * для текста отказа; тела блоков и групп разбираются тем же разбором в
 * своих границах.
 */
class Parser {
  readonly #words: readonly string[];
  readonly #commands: Commands;
  readonly #root: Root;
  #at = 0;
  #to: number;
  #names = new Names();
  #statement = 0;
  #label = "";

  constructor(words: readonly string[], commands: Commands, root: Root) {
    this.#words = words;
    this.#to = words.length;
    this.#commands = commands;
    this.#root = root;
  }

  /** Место в тексте отказа: номер верхнего выражения и блок. */
  place(): string {
    const head = `выражение ${this.#statement}`;
    return this.#label === "" ? head : `${head}, ${this.#label}`;
  }

  program(): Program {
    return new Program(this.#statements((n) => this.#statement = n));
  }

  /**
   * Выражения через `.` до границы; точка в конце допустима. `begins`
   * узнаёт номер каждого — месту отказа нужен номер верхнего.
   */
  #statements(begins: (n: number) => void): Expression[] {
    const list: Expression[] = [];
    for (;;) {
      this.#skip();
      if (this.#over()) return list;
      begins(list.length + 1);
      list.push(this.#statement1());
      this.#skip();
      if (this.#over()) return list;
      // Цепочка кончается только на разделителе: прочее она отвергла.
      this.#at++;
    }
  }

  #statement1(): Expression {
    if (this.#peek(1) === GRAMMAR.assign) return this.#assignment();
    return this.#chain();
  }

  #assignment(): Expression {
    const name = this.#word();
    const span = this.#span(2);
    if (GRAMMAR_WORDS.has(name)) {
      throw misplaced(`${name} — слово грамматики, выбери другое имя`, span);
    }
    if (!isPlain(name) || NUMBER.test(name) || name.includes(".")) {
      throw misplaced(`${name} — не имя переменной`, span);
    }
    if (this.#root.reserves(name)) {
      throw misplaced(`${name} — сообщение корня, выбери другое имя`, span);
    }
    // Имя связано до правой части: блок может звать себя (`f := do … @f`).
    this.#names.bind(name);
    this.#at += 2;
    return new Assignment(name, this.#chain());
  }

  #chain(): Expression {
    const primary = this.#primary();
    const messages = this.#messages(primary);
    return new Chain(primary.expression, messages);
  }

  #primary(): Primary {
    this.#skip();
    const word = this.#over() ? GRAMMAR.separator : this.#word();
    if (word === GRAMMAR.separator || word === GRAMMAR.close) {
      throw misplaced("пустое выражение", this.#span(1));
    }
    if (NUMBER.test(word)) return plain(this.#literal(new Num(Number(word))));
    if (word.startsWith(GRAMMAR.quote)) return plain(this.#text());
    if (word.startsWith(GRAMMAR.variable)) return plain(this.#variable());
    if (word === GRAMMAR.open) return plain(this.#closed("").expression);
    this.#stray(word);
    if (this.#names.has(word)) {
      return plain(this.#literalAt(new Variable(word)));
    }
    return this.#command();
  }

  /** Сообщения результатам по порядку до конца выражения. */
  #messages(primary: Primary): Message[] {
    const list: Message[] = [];
    for (;;) {
      this.#skip();
      if (this.#over()) return list;
      const word = this.#word();
      if (word === GRAMMAR.separator) return list;
      if (word === GRAMMAR.close) {
        this.#at++;
        continue;
      }
      if (isKey(word)) {
        list.push(this.#keyword(list.length === 0 ? primary : NO_CHECK));
        continue;
      }
      list.push(this.#unary());
    }
  }

  #unary(): Message {
    const start = this.#at;
    const word = this.#word();
    if (word === GRAMMAR.literal) {
      this.#at += 2;
      return new Unary(this.#literalWord(start), this.#spanFrom(start));
    }
    this.#stray(word);
    if (word.startsWith(GRAMMAR.quote) || word.startsWith(GRAMMAR.variable)) {
      throw misplaced(`значение без ключа: ${word}`, this.#span(1));
    }
    this.#at++;
    return new Unary(word, this.#spanFrom(start));
  }

  /** Слово за `--` на позиции `start`. */
  #literalWord(start: number): string {
    if (start + 1 >= this.#to) {
      throw misplaced(`после ${GRAMMAR.literal} нет слова`, this.#span(1));
    }
    return this.#words[start + 1];
  }

  /** Слова грамматики не на своём месте. */
  #stray(word: string) {
    const span = this.#span(1);
    if (word === GRAMMAR.open) {
      throw misplaced(
        `${GRAMMAR.open} — в начале выражения или на месте значения`,
        span,
      );
    }
    if (word === GRAMMAR.blockEnd) {
      throw misplaced(`${GRAMMAR.blockEnd} без открытого блока`, span);
    }
    if (word === GRAMMAR.assign) {
      throw misplaced("присваивание — только в начале выражения", span);
    }
  }

  #keyword(primary: Primary): Message {
    const start = this.#at;
    const keys: string[] = [];
    const args: Expression[] = [];
    while (!this.#over() && isKey(this.#word())) {
      const key = this.#word().slice(0, -GRAMMAR.parameter.length);
      this.#at++;
      args.push(this.#argument(key));
      keys.push(key);
      this.#skip();
    }
    const span = this.#spanFrom(start);
    primary.check(keys, span);
    return new Keyword(keys, args, span);
  }

  /** Значение ключа сообщения значению программы: объектом. */
  #argument(key: string): Expression {
    this.#skip();
    const word = this.#over() ? GRAMMAR.separator : this.#word();
    if (endsValue(word) || isKey(word)) {
      throw misplaced(`у ключа ${key} нет значения`, this.#span(1));
    }
    if (word === GRAMMAR.literal) {
      const text = this.#literalWord(this.#at);
      this.#at += 2;
      return new Constant(new Text(text));
    }
    if (word.startsWith(GRAMMAR.quote)) return this.#text();
    if (word.startsWith(GRAMMAR.variable)) {
      return new Chain(this.#variable(), this.#unaries());
    }
    if (word === GRAMMAR.open) return this.#closedValue(key);
    this.#bare(word);
    return this.#literal(
      NUMBER.test(word) ? new Num(Number(word)) : new Text(word),
    );
  }

  /** Связанное голое имя на месте значения — отказ до исполнения. */
  #bare(word: string) {
    if (!this.#names.has(word)) return;
    throw misplaced(
      `переменная в значении — ${GRAMMAR.variable}${word}; ` +
        `текст — ${GRAMMAR.literal} ${word}`,
      this.#span(1),
      "переменная в значении",
    );
  }

  /** Унарные за значением-переменной или группой — сообщения им. */
  #unaries(): Message[] {
    const list: Message[] = [];
    for (;;) {
      this.#skip();
      if (this.#over()) return list;
      const word = this.#word();
      if (!isPlain(word) || stops(word)) return list;
      list.push(this.#unary());
    }
  }

  /** `do` на месте значения: блок — сам, группа — с унарными за ней. */
  #closedValue(key: string): Expression {
    const { expression, groups } = this.#closed(`${key}:`);
    return groups ? new Chain(expression, this.#unaries()) : expression;
  }

  /** `do … end` или `do … done` с позиции разбора. */
  #closed(by: string): { expression: Expression; groups: boolean } {
    const closer = closerOf(this.#words, this.#at, this.#to);
    const body = this.#within(
      closer.body,
      closer.end,
      closer.names(this.#names),
      closer.label(by, this.#label),
    );
    this.#at = closer.end + 1;
    return { expression: closer.node(body), groups: closer.takesUnaries() };
  }

  /** Тело в границах `[from, to)` своими именами и местом. */
  #within(from: number, to: number, names: Names, label: string): Statements {
    const saved = { at: this.#at, to: this.#to, names: this.#names };
    const outerLabel = this.#label;
    this.#at = from;
    this.#to = to;
    this.#names = names;
    this.#label = label;
    const list = this.#statements(() => {});
    this.#at = saved.at;
    this.#to = saved.to;
    this.#names = saved.names;
    this.#label = outerLabel;
    return new Statements(list);
  }

  #text(): Expression {
    const { text, next } = textAt(this.#words, this.#at, this.#to);
    this.#at = next;
    return new Constant(new Text(text));
  }

  /** `@x`; несвязанной — отказ, каким его скажет `unbound`. */
  #variable(unbound: Unbound = UNBOUND): Expression {
    const word = this.#word();
    const name = word.slice(GRAMMAR.variable.length);
    const span = this.#span(1);
    if (name.includes(".")) {
      const [head, ...fields] = name.split(".");
      throw misplaced(
        `поле — унарным: ${GRAMMAR.variable}${head} ${fields.join(" ")}`,
        span,
        "поле — унарным",
      );
    }
    if (!this.#names.has(name)) {
      throw unbound.refuse(name, word, this.#names.list(), span);
    }
    return this.#literalAt(new Variable(name));
  }

  /** Слово-литерал на позиции разбора: узел, позиция — за ним. */
  #literalAt(expression: Expression): Expression {
    this.#at++;
    return expression;
  }

  #literal(value: Num | Text): Expression {
    return this.#literalAt(new Constant(value));
  }

  /**
   * Команда реестра: путь по дереву, затем слова, которые её (ключи,
   * варианты, хвост), — пока их берёт узел. Ключ, которого команда не
   * знает, и унарное за значением — сообщения её результату.
   */
  #command(): Primary {
    const start = this.#at;
    const path: string[] = [];
    let node = NO_NODE;
    while (!this.#over() && isPlain(this.#word())) {
      const child = this.#commands.node([...path, this.#word()]);
      if (child === undefined) break;
      path.push(this.#word());
      node = child;
      this.#at++;
    }
    this.#known(path, node);
    const parts: Part[] = [new Written(this.#words.slice(start, this.#at))];
    if (node.leaf) {
      const keyed = this.#leafParts(node, parts, start);
      const format = this.#format(node, keyed);
      const reading = format.length === 0 ? AS_VALUE : AS_PRINTED;
      return {
        expression: new Command(
          new Known(path, node.links),
          parts,
          format,
          reading,
        ),
        check: resultCheck,
      };
    }
    this.#plainParts(parts);
    return {
      expression: new Command(UNKNOWN, parts, AS_DATA, AS_VALUE),
      check: resultCheck,
    };
  }

  /**
   * Первое слово за путём понимает корень или группа — иначе отказ до
   * исполнения с ближайшими.
   */
  #known(path: readonly string[], node: CommandNode) {
    if (this.#over() || node.leaf) return;
    const word = this.#word();
    if (!isPlain(word)) return;
    if (path.length === 0 && !this.#root.accepts(word)) {
      throw notKnown("mpu", word, this.#root.messages(), this.#span(1));
    }
    if (path.length > 0 && !REFLECTION.has(word)) {
      const at = ["mpu", ...path].join(" ");
      throw notKnown(at, word, node.messages, this.#span(1));
    }
  }

  /** Слова команды-листа с позиции `start`; набраны ли ключи. */
  #leafParts(node: CommandNode, parts: Part[], start: number): boolean {
    let keyed = false;
    for (;;) {
      this.#skip();
      if (this.#over() || stops(this.#word())) return keyed;
      const word = this.#word();
      const key = keyName(word);
      if (key === undefined) {
        // Голое за значением — сообщение результату ([D.8]).
        if (keyed) return keyed;
        this.#segmentValue("значение", parts);
        continue;
      }
      if (!node.keys.has(key)) return keyed;
      keyed = true;
      this.#noFile(node, key, start);
      this.#keyParts(word, key, node.keys.get(key) === "flag", parts);
    }
  }

  /**
   * Формат за командой — её же строке: он меняет и исполнение, и печать
   * (`end json`; за значением ключа — сразу, [D.8]). Нет — пусто.
   */
  #format(node: CommandNode, keyed: boolean): readonly string[] {
    this.#skip();
    const word = this.#peek(0);
    const next = this.#peek(1);
    if (word === GRAMMAR.close && next !== undefined) {
      if (!node.formats.includes(next)) return [];
      this.#at += 2;
      return [word, next];
    }
    if (!keyed || word === undefined || !node.formats.includes(word)) return [];
    this.#at++;
    return [word];
  }

  /** Слова прочего сегмента: всё до конца выражения. */
  #plainParts(parts: Part[]) {
    for (;;) {
      this.#skip();
      if (this.#over() || stops(this.#word())) return;
      const word = this.#word();
      const key = keyName(word);
      if (key === undefined) this.#segmentValue("значение", parts);
      else this.#keyParts(word, key, false, parts);
    }
  }

  /**
   * `@путь` (и `-- @путь`, `--ключ=@путь`) на месте значения ключа, чей
   * файл читается своим ключом (`body: @req.json`), — отказ до исполнения
   * с готовой строкой `body-file: req.json`: слово на `@` — переменная.
   */
  #noFile(node: CommandNode, key: string, start: number) {
    const fileKey = node.fromFile.get(key);
    if (fileKey === undefined) return;
    const { value, words } = this.#keyValue();
    if (!value.startsWith(GRAMMAR.variable)) return;
    const fixed = [
      `${fileKey}${GRAMMAR.parameter}`,
      value.slice(GRAMMAR.variable.length),
    ];
    const line = [...this.#words.slice(start, this.#at), ...fixed];
    const said = "файл — ключом";
    throw new Misstep(
      new Refusal(`${said}: mpu ${line.join(" ")}`, {
        reason: said,
        remedy: substituted(fixed),
      }),
      this.#span(words),
    );
  }

  /**
   * Значение ключа на позиции разбора, как оно записано, и сколько слов
   * занимают ключ со значением: `--ключ=значение` — одно слово, `ключ: --
   * значение` — три, `ключ: значение` — два. Значения нет — пусто.
   */
  #keyValue(): { readonly value: string; readonly words: number } {
    const word = this.#word();
    const inline = word.indexOf("=");
    if (word.startsWith("--") && inline > 0) {
      return { value: word.slice(inline + 1), words: 1 };
    }
    const escaped = this.#peek(1) === GRAMMAR.literal;
    const value = this.#peek(escaped ? 2 : 1) ?? "";
    return { value, words: escaped ? 3 : 2 };
  }

  /** Ключ сегмента и его значение, если форма его ждёт. */
  #keyParts(word: string, key: string, flag: boolean, parts: Part[]) {
    parts.push(new Written([word]));
    this.#at++;
    const inline = word.includes("=") || flag && word.startsWith("--");
    if (!inline) this.#segmentValue(key, parts);
  }

  /** Значение ключа команды: слова как есть или выражение текстом. */
  #segmentValue(key: string, parts: Part[]) {
    this.#skip();
    if (this.#over() || endsValue(this.#word()) || isKey(this.#word())) return;
    const start = this.#at;
    const word = this.#word();
    if (word === GRAMMAR.literal) {
      this.#literalWord(start);
      this.#at += 2;
      parts.push(new Written(this.#words.slice(start, this.#at)));
      return;
    }
    const computed = this.#computed(key, word);
    if (computed !== undefined) {
      parts.push(new Computed(key, computed, this.#spanFrom(start)));
      return;
    }
    this.#bare(word);
    this.#at++;
    parts.push(new Written([word]));
  }

  /** Значение-выражение: текст, переменная, группа или блок. */
  #computed(key: string, word: string): Expression | undefined {
    if (word.startsWith(GRAMMAR.quote)) return this.#text();
    if (word.startsWith(GRAMMAR.variable)) {
      return new Chain(this.#variable(AS_TEXT_TOO), this.#unaries());
    }
    if (word === GRAMMAR.open) return this.#closedValue(key);
    return undefined;
  }

  /** Пропуск комментариев `rem … end`. */
  #skip() {
    while (!this.#over() && this.#word() === GRAMMAR.comment) {
      const end = this.#words.indexOf(GRAMMAR.close, this.#at + 1);
      this.#at = end < 0 || end >= this.#to ? this.#to : end + 1;
    }
  }

  #over(): boolean {
    return this.#at >= this.#to;
  }

  #word(): string {
    return this.#words[this.#at];
  }

  /** Слово через `n` от позиции в границах; за границей — `undefined`. */
  #peek(n: number): string | undefined {
    return this.#at + n < this.#to ? this.#words[this.#at + n] : undefined;
  }

  #span(length: number): Span {
    return { start: this.#at, end: Math.min(this.#at + length, this.#to) };
  }

  #spanFrom(start: number): Span {
    return { start, end: this.#at };
  }
}

/**
 * Узла нет: слово в начале выражения — сообщение корню, не команда
 * дерева. Единственный null-объект узла в модуле.
 */
const NO_NODE: CommandNode = {
  leaf: false,
  keys: new Map(),
  messages: [],
  formats: [],
  fromFile: new Map(),
  links: [],
};

/** Хвост строки без команды: её напечатанное — данные JSON. */
const AS_DATA: readonly string[] = [GRAMMAR.close, "json"];

/** Слова протокола отражения: их понимает любой узел. */
const REFLECTION: ReadonlySet<string> = new Set([
  "help",
  "messages",
  "keys",
  "formats",
  "variants",
]);

/** Первичное без проверки остатка. */
const NO_CHECK: Primary = plain(new Constant(new Text("")));

/**
 * Остаток ключевого за командой — её результату (деление склеенного):
 * понимает ли его результат-данные, проверяется до исполнения.
 */
function resultCheck(keys: readonly string[], span: Span) {
  let rest = keys;
  while (rest.length > 0) {
    const taken = RESULT.take(rest);
    if (taken === 0) throw new Misstep(RESULT.refusal(selectorOf(rest)), span);
    rest = rest.slice(taken);
  }
}

/** Как отказать несвязанной `@x`. */
interface Unbound {
  refuse(
    name: string,
    word: string,
    bound: readonly string[],
    span: Span,
  ): Misstep;
}

/** Вид отказа несвязанной переменной. */
const NOT_BOUND = "не связана";

/** Отказ «`x` не связана» и какие связаны. */
function unboundText(name: string, bound: readonly string[]): string {
  const said = bound.length === 0
    ? "связанных нет"
    : `связаны: ${bound.join(", ")}`;
  return `${name} не связана; ${said}`;
}

/** Несвязанная переменная в выражении: связать нечем. */
const UNBOUND: Unbound = {
  refuse: (name, _word, bound, span) =>
    misplaced(unboundText(name, bound), span, NOT_BOUND),
};

/**
 * Несвязанная `@x` в значении ключа команды — возможно, текст
 * (`to: @all`): подсказка — то же слово за `--`.
 */
const AS_TEXT_TOO: Unbound = {
  refuse: (name, word, bound, span) =>
    new Misstep(
      new Refusal(
        `${unboundText(name, bound)}; текстом — ${GRAMMAR.literal} ${word}`,
        { reason: NOT_BOUND, remedy: substituted([GRAMMAR.literal, word]) },
      ),
      span,
    ),
};

/** Отказ до исполнения. */
function misplaced(text: string, span: Span, reason = text): Misstep {
  return unparsed(text, span.start, span.end, reason);
}

/** `doesNotUnderstand` корня или группы — с ближайшими. */
function notKnown(
  at: string,
  word: string,
  known: readonly string[],
  span: Span,
): Misstep {
  const close = nearest(word, [...known].sort());
  return new Misstep(
    notUnderstood(`${at}: не понимает ${word}`, word, close, "ближайшие"),
    span,
  );
}

/**
 * Разбирает слова программы в узлы и проверяет то, что отказывает до
 * исполнения.
 *
 * @param commands дерево команд реестра
 * @param root что понимает корень строки; у исполнителя — `LENIENT_ROOT`
 * @throws Placed — отказ до исполнения с местом
 */
export function parseProgram(
  words: readonly string[],
  commands: Commands,
  root: Root,
): Program {
  const parser = new Parser(words, commands, root);
  try {
    return parser.program();
  } catch (err) {
    if (!(err instanceof Misstep || err instanceof Refusal)) throw err;
    throw placed(err, parser.place());
  }
}
