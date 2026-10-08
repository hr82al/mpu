/**
 * Строки образа (`platform/image.md`, «Определение», «Удаление»):
 * `<получатель> define: <имя> purpose: … do … done` и `<получатель>
 * forget: <имя>`. Их ядро узнаёт раньше программы: блок значением ключа
 * команды не уходит, а записывает метод ядро — у него образ и правила.
 */

import { GRAMMAR, UNNAMED_REFUSAL } from "@mpu/language/messages";
import {
  DEFINE,
  type Image,
  ImageError,
  ImageMethod,
  isPlain,
  PURPOSE,
  saidOf,
  storedName,
} from "@mpu/cmd-image";
import {
  isProtocol,
  line as lineText,
  plainRefusal,
  RefusalNotice,
  type Refused,
  ROOT_TEXT,
  throughGate,
} from "@mpu/language/objects";
import {
  ALLOW,
  ASK,
  type Channel,
  PolicyError,
  Rule,
  type RuleBook,
  RulePath,
  type Verdict,
} from "@mpu/command/policy";
import {
  type Commands,
  parseMethodBody,
  Placed,
  refusalOf,
  type Root,
} from "@mpu/language/program";
import type { CommandIo } from "@mpu/command";
import { atExecution, type HookReply } from "@mpu/cmd-claudehook";
import type { Line } from "./dispatch.ts";
import { printed, type Speech } from "./printed.ts";
import { registryNodes, type TreeNode } from "./tree.ts";
import { ASK_WORD, NEEDS_DOOR, NORMAL, type View } from "./view.ts";

/** Сообщение удаления метода. */
const FORGET = "forget:";

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
  /**
   * Строка исполнилась — её отказ или запись; ей быть в журнале вызовов,
   * как любой команде (`platform/image.md`, «Журнал вызовов»).
   */
  readonly journaled: () => void;
  /** Окружение строки: `HOME`, `cwd`, кэш-БД с ключом `image.dir`. */
  readonly io: Pick<CommandIo, "env" | "cwd" | "openCacheDb">;
  /**
   * Строка обычной цепочкой, где исполнение листа — у `wrap`: сессию
   * строки и её слова он получает, строку, которой исполнять, отдаёт.
   */
  readonly walk: (
    wrap: (session: Line, words: readonly string[]) => Line,
  ) => Promise<number>;
}

/** Что нужно проверкам определения: дерево, корень, автор и часы. */
export type Checking = Pick<
  ImageContext,
  "said" | "commands" | "root" | "author" | "now"
>;

/** Строка образа: определение, удаление или ни то ни другое. */
export interface ImageLine {
  /** Исполнить строку; не строка образа — `otherwise`. */
  settle(
    context: ImageContext,
    otherwise: () => Promise<number>,
  ): Promise<number>;
  /**
   * Ответ хука `PreToolUse` на эту строку, ничего не исполняя; не
   * строка образа — `otherwise`.
   */
  consult(otherwise: () => Promise<HookReply>): Promise<HookReply>;
}

/** Не строка образа: исполняется, как прежде. Null-объект модуля. */
export const NOT_IMAGE: ImageLine = {
  settle: (_context, otherwise) => otherwise(),
  consult: (otherwise) => otherwise(),
};

/** Строку набрали не так: отказ до записи. */
export class Misdefined extends Error {
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

/**
 * Строка образа по словам без входа двери: получатель — голые слова до
 * первого `define:` или `forget:`; иначе — `otherwise`.
 */
export function imageLineOf(
  said: readonly string[],
  otherwise: ImageLine = NOT_IMAGE,
): ImageLine {
  const at = said.findIndex((word) => word === DEFINE || word === FORGET);
  if (at < 1 || !said.slice(0, at).every(isPlain)) return otherwise;
  const receiver = said.slice(0, at);
  if (said[at] === FORGET) {
    if (said.length !== at + 2) return otherwise;
    return new Forgetting(receiver, said[at + 1]);
  }
  return new Definition(receiver, said.slice(at + 1), at + 1);
}

/**
 * Определение по словам строки определения, уже найденной разбором файла
 * метода (`image-sync.md`, «Запись стороны базы»): получатель — до
 * `define:`.
 */
export function definitionOf(words: readonly string[]): Definition {
  const at = words.indexOf(DEFINE);
  return new Definition(words.slice(0, at), words.slice(at + 1), at + 1);
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
export function ruled(
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
      // Отметка после «да»: вопрос двери в запись не попадает, а отказ
      // правил и двери записи не оставляет, как у любой команды.
      run: () => {
        context.journaled();
        return run();
      },
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

/** Определение метода. */
export class Definition implements ImageLine {
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

  consult(): Promise<HookReply> {
    return atExecution();
  }

  async settle(context: ImageContext): Promise<number> {
    let checked;
    try {
      checked = this.checked(context);
    } catch (err) {
      if (!(err instanceof Misdefined)) throw err;
      context.journaled();
      err.refused.tell(context.speech);
      return MISWRITTEN;
    }
    const { method, reach } = checked;
    return await ruled(context, [...this.#receiver, DEFINE], () =>
      written(context, method, reach),
    );
  }

  /**
   * Метод строки, прошедший проверки по порядку таблицы спеки
   * (получатель, назначение, тело, имя), и обход его тела; правил и
   * вопроса нет.
   *
   * @throws Misdefined — строку набрали не так
   */
  checked(context: Checking) {
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
  #said() {
    const said = saidOf(this.#rest);
    if (said.unclosed !== undefined) {
      throw misdefined(
        this.#receiver,
        "текст не закрыт",
        `${said.unclosed} текст не закрыт`,
      );
    }
    if (said.purpose === undefined) {
      throw misdefined(
        this.#receiver,
        "метод без назначения",
        `метод без назначения: ${PURPOSE} ${GRAMMAR.quote}…${GRAMMAR.quote}`,
      );
    }
    return { purpose: said.purpose, keys: said.keys, body: said.body };
  }

  /** Тело — блок `do … done`, разобранный как программа. */
  #body(context: Checking, at: number) {
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
  const name = storedName(word, params);
  if (!word.includes(":") && params === 0) return name;
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
    ? name
        .split(":")
        .filter((part) => part !== "")
        .map((part) => `${part}:`)
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
  reach: (into: {
    command(path: readonly string[], links: readonly string[]): void;
  }) => void,
  book: RuleBook,
): Verdict {
  const found: (readonly string[])[] = [];
  reach({ command: (_path, links) => found.push(links) });
  const quiet = found.every((links) => book.decide(links).admits(NORMAL));
  return quiet ? ALLOW : ASK;
}

/** Достижимые команды тела метода — обходом, как у программы. */
export type Reach = Parameters<typeof seedOf>[0];

/** Что нужно записи метода: образ и правила. */
export type Keeping = Pick<ImageContext, "image" | "book">;

/**
 * Записывает метод и правило его пути, посеянное обходом тела; итог —
 * запись правила.
 *
 * @throws ImageError, PolicyError — файл образа или правил не пишется
 */
export function keep(
  keeping: Keeping,
  method: ImageMethod,
  reach: Reach,
): { readonly path: string; readonly verdict: string } {
  const verdict = seedOf(reach, keeping.book);
  const path = RulePath.parse(method.links().join(" "));
  keeping.image.define(method);
  keeping.book.set(path, verdict);
  return { path: path.text(), verdict: verdict.word };
}

/** Запись метода и его правила; итог — видом изменения правила. */
async function written(
  context: ImageContext,
  method: ImageMethod,
  reach: Reach,
): Promise<number> {
  try {
    const entry = keep(context, method, reach);
    await context.changed();
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

  consult(): Promise<HookReply> {
    return atExecution();
  }

  settle(context: ImageContext): Promise<number> {
    const method = context.methods.find((one) =>
      one.named(this.#receiver, this.#written),
    );
    if (method === undefined) {
      const at = this.#receiver.join(" ");
      const name = this.#written.endsWith(":")
        ? this.#written
        : `${this.#written}:`;
      const address = lineText(ROOT_TEXT, [...this.#receiver, FORGET]);
      context.journaled();
      plainRefusal("нет метода", `${address} у ${at} нет метода ${name}`).tell(
        context.speech,
      );
      return Promise.resolve(FAILED);
    }
    return ruled(context, [...this.#receiver, FORGET], () =>
      forgotten(context, method),
    );
  }
}

/**
 * Удаляет метод и правило его пути; итог — путь снятого правила.
 *
 * @throws ImageError, PolicyError — файл образа или правил не пишется
 */
export function drop(keeping: Keeping, method: ImageMethod): string {
  const path = RulePath.parse(method.links().join(" "));
  const { receiver, name } = method.record();
  keeping.image.forget(receiver, name);
  keeping.book.forget(path);
  return path.text();
}

/** Удаление метода и правила его пути; итог — видом снятия правила. */
async function forgotten(
  context: ImageContext,
  method: ImageMethod,
): Promise<number> {
  try {
    const path = drop(context, method);
    await context.changed();
    const entry = { path, verdict: null };
    return printed({ path: [], value: entry }, context.speech);
  } catch (err) {
    return broken(err, context.speech);
  }
}
