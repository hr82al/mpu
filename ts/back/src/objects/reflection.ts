/**
 * Протокол отражения (`platform/reflection.md`): сообщения, которые
 * понимает любой объект, — что он понимает, какие у него ключи, форматы и
 * значения ключей. Одна реализация на все виды: сообщения спрашивают
 * `Reflection` вида и ничего не исполняют.
 */

import type {
  KeyKind,
  KeywordMethod,
  ReceiverDescription,
} from "../messages/mod.ts";
import { dataHelp, ended } from "./result.ts";
import { Description, keyword, type Method, unary } from "./method.ts";
import { order } from "./nearest.ts";
import { atAddress, NO_REMEDY } from "./remedy.ts";
import { Refusal, RENAMED } from "./refusal.ts";
import { SILENT } from "./silent.ts";
import {
  type Call,
  type Doc,
  HELP_SELECTOR,
  type KeyLine,
  type MessageLine,
  type Named,
  type Outcome,
  type Receiver,
  type Reflection,
  type Report,
  type Sent,
  type Shown,
  type ValueLine,
  type Yields,
} from "./protocol.ts";

/** Ответ протокола: данные и их текстовый вид (`end json` — данные). */
class Listing implements Shown, Receiver {
  readonly #data: unknown;
  readonly #text: string;

  constructor(data: unknown, text: string) {
    this.#data = data;
    this.#text = text;
  }

  text(): string {
    return this.#text;
  }

  data(): unknown {
    return this.#data;
  }

  lookup(sent: Sent): Call {
    return ended(this, sent);
  }

  final(report: Report): Promise<Outcome> {
    return Promise.resolve(report.shown(this));
  }
}

/** Строки текстового вида: по строке на элемент, перевод строки в конце. */
function lines(rows: readonly string[]): string {
  return rows.map((row) => `${row}\n`).join("");
}

/** Вид ответа протокола: справка и разбор — как у данных. */
export const LISTED: Yields<Listing> = {
  parsing: () => ({ unary: [], keyword: [] }),
  about: (path, doc) => dataHelp(path, doc),
  remedy: () => NO_REMEDY,
  reflect: () => ({ ...SILENT, formats: () => ["json"] }),
  receive: (listing) => listing,
};

/** Сообщения по строкам: `<selector>\t<purpose>`. */
export function messageListing(messages: readonly MessageLine[]): Listing {
  const rows = messages.map((line) => `${line.selector}\t${line.purpose}`);
  return new Listing(messages, lines(rows));
}

/** Значения по строкам: `<value>\t<purpose>`. */
export function valueListing(values: readonly ValueLine[]): Listing {
  const rows = values.map((line) => `${line.value}\t${line.purpose}`);
  return new Listing(values, lines(rows));
}

/** Слова дополнения по строкам: `<word>\t<purpose>`. */
export function wordListing(
  words: readonly { readonly word: string; readonly purpose: string }[],
): Listing {
  const rows = words.map((line) => `${line.word}\t${line.purpose}`);
  return new Listing(words, lines(rows));
}

function keyListing(keys: readonly KeyLine[]): Listing {
  const rows = keys.map((key) =>
    [key.name, key.kind, key.required ? "обязателен" : "-", key.purpose]
      .join("\t")
  );
  return new Listing(keys, lines(rows));
}

function about(purpose: string): Doc {
  return { purpose, help: `${purpose[0].toUpperCase()}${purpose.slice(1)}.` };
}

/** Прежнее имя сообщения: отказ с готовой строкой нового. */
function renamed(old: string, now: string, words: (args: Named) => string[]) {
  return (sent: Named): never => {
    const colon = sent.selector().endsWith(":") ? ":" : "";
    const spelled = [`${now}${colon}`, ...words(sent)];
    throw new Refusal(`${old} — теперь ${now}`, {
      reason: RENAMED,
      remedy: atAddress(": ", () => spelled),
    });
  };
}

/** Прежние имена протокола: они разбираются, чтобы отказать. */
const RETIRED: ReadonlyMap<string, (sent: Named) => never> = new Map([
  ["selectors", renamed("selectors", "messages", () => [])],
  [
    "respondsTo:",
    renamed("respondsTo", "understands", (sent) => [
      String(sent.args().respondsTo),
    ]),
  ],
]);

const PROTOCOL: readonly Method<Reflection>[] = [
  unary(
    "messages",
    about("собственные сообщения объекта"),
    LISTED,
    (self) => messageListing(self.messages()),
  ),
  keyword(
    { understands: "value" },
    ["understands"],
    about("понимает ли объект сообщение"),
    LISTED,
    (self, args) => {
      const selector = String(args.understands);
      const answer = self.understands(selector) || isProtocol(selector);
      return new Listing(answer, `${answer}\n`);
    },
  ),
  unary(
    "keys",
    about("ключи ключевого сообщения команды"),
    LISTED,
    (self) => keyListing(self.keys()),
  ),
  unary(
    "formats",
    about("форматы результата — без исполнения"),
    LISTED,
    (self) => {
      const formats = self.formats();
      return new Listing(formats, lines(formats));
    },
  ),
  unary(
    "variants",
    about("варианты команды"),
    LISTED,
    (self) => {
      const variants = self.variants();
      const rows = variants.map((line) => `${line.selector}\t${line.purpose}`);
      return new Listing(variants, lines(rows));
    },
  ),
  keyword(
    { candidates: "value", like: "value" },
    ["candidates"],
    about("значения ключа, начинающиеся с like:"),
    LISTED,
    async (self, args) =>
      valueListing(
        await self.candidates(
          String(args.candidates),
          String(args.like ?? ""),
        ),
      ),
  ),
];

const BY_SELECTOR: ReadonlyMap<string, Method<Reflection>> = new Map(
  PROTOCOL.map((method) => [method.selector, method]),
);

/** Слова протокола, которые понимает любой объект. */
const PROTOCOL_WORDS: ReadonlySet<string> = new Set([
  HELP_SELECTOR,
  ...BY_SELECTOR.keys(),
  ...PROTOCOL.flatMap((method) => {
    const into = new Description();
    method.describe(into);
    return into.build().keyword.flatMap((one) =>
      Object.keys(one.keys).map((key) => `${key}:`)
    );
  }),
]);

/**
 * Метод протокола для сообщения, если оно из протокола; прежнее имя —
 * отказ с готовой строкой; иначе — нет.
 *
 * @param sent сообщение с селектором
 * @param reflection что вид знает о себе
 */
export function reflected(
  sent: Named,
  reflection: Reflection,
): Call | undefined {
  const selector = sent.selector();
  const retired = RETIRED.get(selector);
  if (retired !== undefined) return retired(sent);
  return BY_SELECTOR.get(selector)?.bind(reflection, sent);
}

/** Добавляет протокол в описание для разбора. */
export function withProtocol(into: Description): Description {
  // `help` в словарь не входит: его убирает из строки режим справки.
  into.unary(HELP_SELECTOR);
  into.unary("selectors");
  into.keyword({ keys: { respondsTo: "value" }, required: ["respondsTo"] });
  for (const method of PROTOCOL) method.describe(into);
  return into;
}

/** Описание для разбора с протоколом: у вида без собственных сообщений. */
export function protocolParsing(
  own: ReceiverDescription = { unary: [], keyword: [] },
): ReceiverDescription {
  const into = new Description();
  for (const selector of own.unary) into.unary(selector);
  for (const method of own.keyword) into.keyword(method);
  return withProtocol(into).build();
}

/** Понимает ли объект слово протокола. */
export function isProtocol(selector: string): boolean {
  return PROTOCOL_WORDS.has(selector);
}

/** Как ключ набирают в строке: флаг — `--имя`, прочие — `имя:`. */
export function spelled(name: string, kind: KeyKind): string {
  return kind === "flag" ? `--${name}` : `${name}:`;
}

/** Первый ключ ключевого метода: первый обязательный, иначе первый. */
export function firstKey(method: KeywordMethod): string {
  const names = Object.keys(method.keys);
  return names.find((name) => method.required.includes(name)) ?? names[0];
}

/** Ключевой метод сообщением: первым ключом и его назначением. */
export function keywordLine(method: KeywordMethod, purpose = ""): MessageLine {
  const key = firstKey(method);
  return {
    selector: `${key}:`,
    kind: "keyword",
    purpose: method.purposes?.[key] ?? purpose,
  };
}

/** Строки ключей ключевого метода глазами отражения. */
export function keyLines(method: KeywordMethod): KeyLine[] {
  return Object.entries(method.keys).map(([name, kind]) => ({
    name,
    kind,
    required: method.required.includes(name),
    purpose: method.purposes?.[name] ?? "",
    reason: method.reasons?.[name] || null,
  }));
}

/** Сообщения по алфавиту селектора. */
export function sorted(messages: readonly MessageLine[]): MessageLine[] {
  return [...messages].sort((a, b) => order(a.selector, b.selector));
}
