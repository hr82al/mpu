/**
 * Протоколы модели объектов (`docs/specs/platform/objects.md`). Здесь
 * только интерфейсы: реализации — в соседних файлах, и ни одна из них не
 * знает о другой больше, чем говорит протокол.
 */

import type {
  KeyKind,
  KeyValue,
  ReceiverDescription,
} from "../messages/mod.ts";
import type { Help } from "./help.ts";

/**
 * Слово справки: общий селектор, звено пути в режиме справки и слово
 * строки, которое этот режим включает.
 */
export const HELP_SELECTOR = "help";

/** Назначение и текст справки метода (или корня). */
export interface Doc {
  readonly purpose: string;
  readonly help: string;
  /** Строки вызова для раздела «Примеры»; нет — пусто. */
  readonly examples?: readonly string[];
}

/** Значения ключей ключевого сообщения. */
export type Args = Readonly<Record<string, KeyValue>>;

/** Итог цепочки — данные границы контракта. */
export type Outcome =
  | { readonly path: readonly string[]; readonly value: unknown }
  | { readonly path: readonly string[]; readonly object: string }
  | { readonly path: readonly string[]; readonly exit: number }
  | { readonly error: string; readonly code: 2 };

/**
 * Подсказка к слову, которое стоит за значением ключа: как надо. Пусто —
 * подсказать нечего.
 */
export interface Remedy {
  /**
   * @param address адрес до ключевого сообщения
   * @param taken слова ключевого сообщения, как в строке
   */
  spell(address: string, taken: readonly string[]): string;
}

/** Сообщение, которое понимает объект (`platform/reflection.md`). */
export interface MessageLine {
  readonly selector: string;
  readonly kind: "unary" | "keyword";
  readonly purpose: string;
}

/** Ключ ключевого сообщения команды глазами отражения. */
export interface KeyLine {
  readonly name: string;
  readonly kind: KeyKind;
  readonly required: boolean;
  readonly purpose: string;
  /** Причина имени вне словаря; из словаря — `null`. */
  readonly reason: string | null;
}

/** Значение, подходящее ключу, или слово дополнения. */
export interface ValueLine {
  readonly value: string;
  readonly purpose: string;
}

/**
 * Что вид знает о себе без исполнения: на этом работают протокол
 * отражения, дополнение и снимок дерева.
 */
export interface Reflection {
  /** Собственные сообщения по алфавиту; ключевое — первым ключом. */
  messages(): MessageLine[];
  /** Ключи ключевого сообщения команды; нет — пусто. */
  keys(): KeyLine[];
  formats(): string[];
  /** Значения ключа `key`, начинающиеся с `like`, — не больше 20. */
  candidates(key: string, like: string): Promise<ValueLine[]>;
  understands(selector: string): boolean;
  /** Ключ `key` команда при терминале читает сама (`sql`). */
  prompts(key: string): boolean;
}

/**
 * Где исполнитель строки вычисляет значения ключей
 * (`platform/value-expression.md`): у строки, а не у дерева объектов.
 */
export interface ValueEvaluation {
  /** Результат группы `words` — значением ключа `key`. */
  group(words: readonly string[], key: string): Promise<string>;
  /**
   * stdin строки — значением ключа `key`; `prompts` — ключ команда при
   * терминале читает сама. `undefined` — ключ остаётся без значения.
   */
  stdin(key: string, prompts: boolean): Promise<string | undefined>;
}

/** Вид результата метода: известен без исполнения метода. */
export interface ResultKind {
  /** Что вид знает о себе: сообщения, ключи, форматы, значения. */
  reflect(): Reflection;
  /** Описание для шага разбора: собственные селекторы плюс общие. */
  parsing(): ReceiverDescription;
  /** Справка метода с назначением `doc`, вернувшего бы этот вид. */
  about(path: string, doc: Doc): Help;
  /**
   * Подсказка к слову `word`, стоящему за значением ключа; `after` —
   * слова строки за ним.
   */
  remedy(word: string, after: readonly string[]): Remedy;
}

/** Вид результата, который превращает ответ метода в приёмник. */
export interface Yields<T> extends ResultKind {
  receive(answer: T): Receiver;
}

/** Путь цепочки: звенья для правил и текст для человека. */
export interface Trace {
  /** Звено исполненного сообщения. */
  step(link: string, text: string): void;
  /** Начало текста без звена (корень). */
  begin(text: string): void;
  /**
   * Слово в стороне: оно есть в адресе строки, но не в звеньях правил и
   * не в тексте, которым строку называют правила (вход `ask`, закрытие,
   * формат).
   */
  aside(text: string): void;
  /** Адрес с ещё одним словом на конце. */
  textWith(text: string): string;
}

/** Данные со своим видом по умолчанию (справка): текст и данные. */
export interface Shown {
  text(): string;
  data(): unknown;
}

/** Как итог спрашивает приёмник, на котором кончились слова. */
export interface Report {
  value(data: unknown): Outcome;
  /** Данные со своим видом: без формата — текст, `json` — данные. */
  shown(item: Shown): Outcome;
  object(): Outcome;
  /** Приёмник сделал своё сам и назвал код завершения. */
  exit(code: number): Outcome;
  /** Звенья пути строки: по ним решают правила подтверждения. */
  links(): readonly string[];
  /**
   * Путь строки текстом (`mpu kiten card 123`) для человека — без слов
   * входа: так строку называют вопрос и отказы правил.
   */
  text(): string;
  /** Та же строка текстом, набранная через вход `gate`. */
  through(gate: string): string;
}

/** Приёмник сообщения в цепочке. */
export interface Receiver {
  /** Метод, который ответит на сообщение; отказ — `Refusal`. */
  lookup(sent: Sent): Call;
  /** Итог, если слова кончились на этом приёмнике. */
  final(report: Report): Promise<Outcome>;
}

/** Метод, связанный с приёмником и сообщением, ещё не исполненный. */
export interface Call {
  trace(trail: Trace): void;
  result(): ResultKind;
  /** Справка того, что вызов вернул бы, — без исполнения. */
  help(trail: Trace): Help;
  perform(): Promise<Receiver>;
}

/** Куда сообщение, понятое как произвольное слово, уходит у вида. */
export interface LinkTarget {
  /** Одно произвольное слово. */
  word(word: string): Call;
  /** Хвост: остаток строки. */
  words(words: readonly string[]): Call;
  refuse(): Call;
}

/** Где вид ищет метод для сообщения. */
export interface Finder {
  /** Сообщение с селектором: свой словарь, общий, ответ на непонятое. */
  named(sent: Named): Call;
  /** Хвост: только ответ вида на непонятое — у словарей селектора нет. */
  tail(): Call;
  /** Закрытие: следующее слово — сообщение результату выражения. */
  close(): Call;
}

/** Исполнитель цепочки глазами сообщения. */
export interface Walker {
  /** `help` — объекту, который обозначает выражение до него. */
  help(): void;
  send(sent: Sent): Promise<void>;
}

/** Сообщение из строки глазами исполнителя. */
export interface Entry {
  enter(walker: Walker): Promise<void>;
}

/** Сообщение, которое уходит приёмнику. */
export interface Sent extends Entry {
  /** Селектор: слово, ключи `a:b:` по алфавиту или первое слово хвоста. */
  selector(): string;
  viaLink(target: LinkTarget): Call;
  route(finder: Finder): Call;
}

/** Сообщение с селектором: у него есть звено и значения ключей. */
export interface Named extends Sent {
  /** Текст звена, как в строке. */
  text(): string;
  args(): Args;
}
