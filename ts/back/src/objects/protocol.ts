/**
 * Протоколы модели объектов (`docs/specs/platform/objects.md`). Здесь
 * только интерфейсы: реализации — в соседних файлах, и ни одна из них не
 * знает о другой больше, чем говорит протокол.
 */

import type { ReceiverDescription } from "../messages/mod.ts";

/**
 * Слово справки: общий селектор, звено пути в режиме справки и слово
 * строки, которое этот режим включает.
 */
export const HELP_SELECTOR = "help";

/** Назначение и текст справки метода (или корня). */
export interface Doc {
  readonly purpose: string;
  readonly help: string;
}

/** Значения ключей ключевого сообщения. */
export type Args = Readonly<Record<string, string | boolean>>;

/** Итог цепочки — данные границы контракта. */
export type Outcome =
  | { readonly path: readonly string[]; readonly value: unknown }
  | { readonly path: readonly string[]; readonly object: string }
  | { readonly path: readonly string[]; readonly exit: number }
  | { readonly error: string; readonly code: 2 };

/** Вид результата метода: известен без исполнения метода. */
export interface ResultKind {
  /** Описание для шага разбора: собственные селекторы плюс общие. */
  parsing(): ReceiverDescription;
  /** Справка метода с назначением `doc`, вернувшего бы этот вид. */
  usage(path: string, doc: Doc): string;
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
   * Слово входа: оно есть в адресе строки, но не в звеньях правил и не
   * в тексте, которым строку называют правила.
   */
  gate(text: string): void;
  /** Адрес с ещё одним словом на конце. */
  textWith(text: string): string;
}

/** Как итог спрашивает приёмник, на котором кончились слова. */
export interface Report {
  value(data: unknown): Outcome;
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
  help(trail: Trace): string;
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
}

/** Исполнитель цепочки глазами сообщения. */
export interface Walker {
  askHelp(): void;
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
