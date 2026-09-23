/**
 * Строки образа (`platform/image.md`, «Определение», «Удаление»):
 * `<получатель> define: <имя> purpose: … do … done` и `<получатель>
 * forget: <имя>`. Их ядро узнаёт раньше программы: блок значением ключа
 * команды не уходит, а записывает метод ядро — у него образ и правила.
 */

import { GRAMMAR, UNNAMED_REFUSAL } from "../messages/mod.ts";
import { type Image, ImageError, ImageMethod } from "../image/mod.ts";
import {
  isProtocol,
  line as lineText,
  plainRefusal,
  RefusalNotice,
  type Refused,
  ROOT_TEXT,
  throughGate,
} from "../objects/mod.ts";
import {
  ALLOW,
  ASK,
  type Channel,
  PolicyError,
  Rule,
  type RuleBook,
  RulePath,
  type Verdict,
} from "../policy/mod.ts";
import {
  type Commands,
  parseMethodBody,
  Placed,
  refusalOf,
  type Root,
} from "../program/mod.ts";
import { printed, type Speech } from "./printed.ts";
import { registryNodes, type TreeNode } from "./tree.ts";
import { ASK_WORD, NEEDS_DOOR, NORMAL, type View } from "./view.ts";

/** Сообщение определения метода. */
const DEFINE = "define:";
/** Сообщение удаления метода. */
const FORGET = "forget:";
/** Ключ назначения — обязателен. */
const PURPOSE = "purpose:";
/** Ключ описания ключей для справки. */
const KEYS = "keys:";

/** Код отказа до записи: строку набрали не так. */
const MISWRITTEN = 2;
/** Код отказа при записи: файл, правило, нет метода. */
const FAILED = 1;

/** Что строке образа нужно от ядра. */
export interface ImageContext {
  /** Слова строки без входа двери. */
  readonly said: readonly string[];
  /** Взгляд, которым пришла строка: дверь или обычный. */
  readonly view: View;
  readonly book: RuleBook;
  readonly channel: Channel;
  readonly speech: Speech;
  readonly image: Image;
  /** Методы образа на начало строки. */
  readonly methods: readonly ImageMethod[];
  /** Дерево команд для разбора тела — с методами образа. */
  readonly commands: Commands;
  /** Что понимает корень строки: имя метода их не занимает. */
  readonly root: Root;
  /** Канал автора: `human`, `agent`, `web`. */
  readonly author: string;
  readonly now: () => Date;
  /** Образ изменился: снимок дерева переписывается. */
  readonly changed: () => Promise<void>;
}

/** Строка образа: определение, удаление или ни то ни другое. */
export interface ImageLine {
  /** Исполнить строку; не строка образа — `otherwise`. */
  settle(
    context: ImageContext,
    otherwise: () => Promise<number>,
  ): Promise<number>;
}

/** Не строка образа: исполняется, как прежде. Null-объект модуля. */
const NOT_IMAGE: ImageLine = { settle: (_context, otherwise) => otherwise() };

/** Строку набрали не так: отказ до записи. */
class Misdefined extends Error {
  override name = "Misdefined";
  readonly refused: Refused;

  constructor(refused: Refused) {
    super(refused.text());
    this.refused = refused;
  }
}

/** Отказ определения с текстом `mpu <получатель> define: <text>`. */
function misdefined(
  receiver: readonly string[],
  reason: string,
  text = reason,
): Misdefined {
  const address = lineText(ROOT_TEXT, [...receiver, DEFINE]);
  return new Misdefined(plainRefusal(reason, `${address} ${text}`));
}

/** Слова грамматики: получателем они не бывают. */
const GRAMMAR_WORDS: ReadonlySet<string> = new Set(Object.values(GRAMMAR));

/** Голое слово: начало строки до сообщения образа. */
function isPlain(word: string): boolean {
  return !word.endsWith(":") && !/^[-^@:]/.test(word) &&
    !GRAMMAR_WORDS.has(word);
}

/**
 * Строка образа по словам без входа двери: получатель — голые слова до
 * первого `define:` или `forget:`.
 */
export function imageLineOf(said: readonly string[]): ImageLine {
  const at = said.findIndex((word) => word === DEFINE || word === FORGET);
  if (at < 1 || !said.slice(0, at).every(isPlain)) return NOT_IMAGE;
  const receiver = said.slice(0, at);
  if (said[at] === FORGET) {
    if (said.length !== at + 2) return NOT_IMAGE;
    return new Forgetting(receiver, said[at + 1]);
  }
  return new Definition(receiver, said.slice(at + 1), at + 1);
}

/** Адресный отказ строке, набранной без двери. */
function doorRefusal(words: readonly string[]): Refused {
  return new RefusalNotice({
    reason: NEEDS_DOOR,
    said: `${lineText(ROOT_TEXT, words)}: ${NEEDS_DOOR}`,
    hint: throughGate(" — вызывай ", ASK_WORD).hint({
      address: "",
      taken: [],
      line: words,
      start: 0,
      end: words.length,
    }),
    candidates: [],
  });
}

/** Отказ файла образа или правил — код 1; прочее — дальше. */
function broken(err: unknown, speech: Speech): number {
  if (!(err instanceof ImageError || err instanceof PolicyError)) throw err;
  plainRefusal(UNNAMED_REFUSAL, err.message).tell(speech);
  return FAILED;
}

/**
 * Решение правил пути `links` (посев `ask` на первом касании) у взгляда
 * строки; «да» — `run`.
 */
function ruled(
  context: ImageContext,
  links: readonly string[],
  run: () => Promise<number>,
): Promise<number> {
  const { book, speech } = context;
  let ruling;
  try {
    book.sow([new Rule(RulePath.parse(links.join(" ")), ASK)]);
    ruling = book.decide(links);
  } catch (err) {
    return Promise.resolve(broken(err, speech));
  }
  return ruling.settle<number>(
    {
      text: lineText(ROOT_TEXT, context.said),
      run,
      refuse: (reason, text) => {
        plainRefusal(reason, text).tell(speech);
        return Promise.resolve(FAILED);
      },
      redirect: () => {
        doorRefusal(context.said).tell(speech);
        return Promise.resolve(MISWRITTEN);
      },
    },
    context.channel,
    context.view,
  );
}

/** Значение ключа определения: `^текст^` или одно слово; позиция за ним. */
function valueAt(
  words: readonly string[],
  at: number,
): { readonly text: string; readonly next: number } | undefined {
  const word = words[at];
  if (word === undefined) return undefined;
  if (!word.startsWith(GRAMMAR.quote)) return { text: word, next: at + 1 };
  const end = words.findIndex((one, i) =>
    i >= at && (i > at || one.length > 1) && one.endsWith(GRAMMAR.quote)
  );
  if (end < 0) return undefined;
  const text = words.slice(at, end + 1).join(" ");
  return {
    text: text.slice(GRAMMAR.quote.length, -GRAMMAR.quote.length),
    next: end + 1,
  };
}

/** Что сказано в строке определения до тела. */
interface Said {
  readonly purpose: string;
  readonly keys: string;
  /** Начало тела в словах после имени. */
  readonly body: number;
}

/** Определение метода. */
class Definition implements ImageLine {
  readonly #receiver: readonly string[];
  /** Слова после `define:`: имя, ключи, тело. */
  readonly #rest: readonly string[];
  /** Где `#rest` начинается в строке. */
  readonly #offset: number;

  constructor(
    receiver: readonly string[],
    rest: readonly string[],
    offset: number,
  ) {
    this.#receiver = receiver;
    this.#rest = rest;
    this.#offset = offset;
  }

  async settle(context: ImageContext): Promise<number> {
    let checked;
    try {
      checked = this.#checked(context);
    } catch (err) {
      if (!(err instanceof Misdefined)) throw err;
      err.refused.tell(context.speech);
      return MISWRITTEN;
    }
    const { method, reach } = checked;
    return await ruled(
      context,
      [...this.#receiver, DEFINE],
      () => written(context, method, reach),
    );
  }

  /** Проверки по порядку таблицы спеки: получатель, назначение, тело, имя. */
  #checked(context: ImageContext) {
    const node = receiverNode(this.#receiver);
    if (node === undefined) {
      throw misdefined(this.#receiver, "метод — только у команды или группы");
    }
    const said = this.#said();
    const body = this.#body(context, said.body);
    const name = methodName(this.#receiver, this.#rest[0], body.params);
    unclaimed(this.#receiver, name, node, context.root);
    const method = new ImageMethod({
      receiver: this.#receiver,
      name,
      words: this.#rest.slice(said.body),
      purpose: said.purpose,
      keys: said.keys,
      author: context.author,
      time: context.now().toISOString(),
    });
    return { method, reach: body.reach };
  }

  /** Назначение и описание ключей до тела; назначения нет — отказ. */
  #said(): Said {
    let purpose: string | undefined;
    let keys = "";
    let at = 1;
    for (;;) {
      const key = this.#rest[at];
      if (key !== PURPOSE && key !== KEYS) break;
      const value = valueAt(this.#rest, at + 1);
      if (value === undefined) {
        throw misdefined(
          this.#receiver,
          "текст не закрыт",
          `${key} текст не закрыт`,
        );
      }
      if (key === PURPOSE) purpose = value.text;
      else keys = value.text;
      at = value.next;
    }
    if (purpose === undefined) {
      throw misdefined(
        this.#receiver,
        "метод без назначения",
        `метод без назначения: ${PURPOSE} ${GRAMMAR.quote}…${GRAMMAR.quote}`,
      );
    }
    return { purpose, keys, body: at };
  }

  /** Тело — блок `do … done`, разобранный как программа. */
  #body(context: ImageContext, at: number) {
    const words = this.#rest.slice(at);
    try {
      return parseMethodBody(words, context.commands, context.root);
    } catch (err) {
      if (!(err instanceof Placed)) throw err;
      const shift = this.#offset + at;
      const span = { start: err.span.start + shift, end: err.span.end + shift };
      const placed = new Placed(err.place, err.refusal, span);
      throw new Misdefined(refusalOf(context.said, placed));
    }
  }
}

/** Узел получателя в дереве реестра; не команда и не группа — нет. */
function receiverNode(receiver: readonly string[]): TreeNode | undefined {
  const path = receiver.join(" ");
  return registryNodes().find((node) => node.path.join(" ") === path);
}

/** Часть имени метода: слово из букв, цифр, `_` и `-`. */
const NAME_PART = /^[\p{L}_][\p{L}\p{N}_-]*$/u;

/**
 * Имя метода по написанному и числу параметров блока: `cardsIn` ≡
 * `cardsIn:`, частей столько, сколько параметров; без параметров — унарное.
 */
function methodName(
  receiver: readonly string[],
  written: string | undefined,
  params: number,
): string {
  const word = written ?? "";
  const parts = word.split(":").filter((part) => part !== "");
  if (parts.length === 0 || !parts.every((part) => NAME_PART.test(part))) {
    throw misdefined(
      receiver,
      "имя метода — слово",
      `имя метода — слово: ${word}`,
    );
  }
  if (!word.includes(":") && params === 0) return word;
  const name = parts.map((part) => `${part}:`).join("");
  if (parts.length !== params) {
    throw misdefined(
      receiver,
      "имя не по параметрам",
      `имя ${name} ждёт ${parts.length} параметра, у блока ${params}`,
    );
  }
  return name;
}

/**
 * Имя свободно: не сообщение получателя, корня или протокола, и не
 * склеивает сообщение получателя с сообщением результату.
 */
function unclaimed(
  receiver: readonly string[],
  name: string,
  node: TreeNode,
  root: Root,
) {
  const own = new Set([
    ...node.messages.map((line) => line.selector),
    ...node.variants.map((line) => line.selector),
    ...node.keys.map((key) => `${key.name}:`),
    DEFINE,
    FORGET,
  ]);
  const taken = (selector: string) =>
    own.has(selector) || isProtocol(selector) || root.reserves(selector);
  const parts = name.includes(":")
    ? name.split(":").filter((part) => part !== "").map((part) => `${part}:`)
    : [name];
  let understood = 0;
  while (understood < parts.length && taken(parts[understood])) understood++;
  const at = receiver.join(" ");
  if (understood === parts.length) {
    throw misdefined(receiver, "имя занято", `${name} у ${at} уже есть`);
  }
  if (understood === 0) return;
  const head = parts.slice(0, understood).join("");
  const tail = parts.slice(understood).join("");
  throw misdefined(
    receiver,
    "имя делится",
    `имя делится на ${head} и ${tail} — выбери другое`,
  );
}

/**
 * Посев правила метода: все достижимые команды тела исполняет обычный
 * взгляд (`allow`) — `allow`, иначе `ask`.
 */
function seedOf(
  reach: (
    into: { command(path: readonly string[], links: readonly string[]): void },
  ) => void,
  book: RuleBook,
): Verdict {
  const found: (readonly string[])[] = [];
  reach({ command: (_path, links) => found.push(links) });
  const quiet = found.every((links) => book.decide(links).admits(NORMAL));
  return quiet ? ALLOW : ASK;
}

/** Запись метода и его правила; итог — видом изменения правила. */
async function written(
  context: ImageContext,
  method: ImageMethod,
  reach: Parameters<typeof seedOf>[0],
): Promise<number> {
  try {
    const verdict = seedOf(reach, context.book);
    const path = RulePath.parse(method.links().join(" "));
    context.image.define(method);
    context.book.set(path, verdict);
    await context.changed();
    const entry = { path: path.text(), verdict: verdict.word };
    return printed({ path: [], value: entry }, context.speech);
  } catch (err) {
    return broken(err, context.speech);
  }
}

/** Удаление метода и его правила. */
class Forgetting implements ImageLine {
  readonly #receiver: readonly string[];
  readonly #written: string;

  constructor(receiver: readonly string[], written: string) {
    this.#receiver = receiver;
    this.#written = written;
  }

  settle(context: ImageContext): Promise<number> {
    const method = context.methods.find((one) =>
      one.named(this.#receiver, this.#written)
    );
    if (method === undefined) {
      const at = this.#receiver.join(" ");
      const name = this.#written.endsWith(":")
        ? this.#written
        : `${this.#written}:`;
      const address = lineText(ROOT_TEXT, [...this.#receiver, FORGET]);
      plainRefusal("нет метода", `${address} у ${at} нет метода ${name}`)
        .tell(context.speech);
      return Promise.resolve(FAILED);
    }
    return ruled(
      context,
      [...this.#receiver, FORGET],
      () => forgotten(context, method),
    );
  }
}

/** Удаление метода и правила его пути; итог — видом снятия правила. */
async function forgotten(
  context: ImageContext,
  method: ImageMethod,
): Promise<number> {
  try {
    const path = RulePath.parse(method.links().join(" "));
    const { receiver, name } = method.record();
    context.image.forget(receiver, name);
    context.book.forget(path);
    await context.changed();
    const entry = { path: path.text(), verdict: null };
    return printed({ path: [], value: entry }, context.speech);
  } catch (err) {
    return broken(err, context.speech);
  }
}
