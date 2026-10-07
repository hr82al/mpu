/**
 * Текст сообщения в Markdown того диалекта, что разбирает `telegram send
 * --md` (`docs/specs/telegram-search.md`, «Разметка текста»): строка из
 * выдачи, отправленная обратно с `--md`, даёт тот же видимый текст и ту же
 * разметку.
 *
 * Обратный ход библиотеки (`md.unparse`) не годится: он экранирует каждый
 * одиночный `-`/`_` и теряет разметку, когда за сущностью сразу идёт
 * экранируемый символ (там же, [D.2]). Поэтому сериализация своя и
 * минимальная, а судья обратимости — разбор библиотеки, в тесте.
 *
 * Тип сущностей берётся только типом: модуль грузится на старте `search`, а
 * клиент MTProto — лениво, в сеансе.
 */

import type { tl } from "@mtcute/node";

/** Правило экранирования символа видимого текста. */
interface Escaping {
  /**
   * Символ в выводе. `next` — первый символ уже собранного хвоста вывода,
   * `lineStart` — символ стоит в начале видимой строки.
   */
  escape(char: string, next: string, lineStart: boolean): string;
  /** Правило для слов ссылки, открытой внутри действия этого. */
  inLink(): Escaping;
}

/**
 * Обычный текст: экранируется ровно то, что разбор истолковал бы как
 * разметку. Одиночные `*_-~|` разметкой не являются — только пара; хвост
 * вывода уже собран, поэтому пару видно по нему и экранирование минимально.
 */
class TextEscaping implements Escaping {
  constructor(
    /** Символы, экранируемые везде, где действует правило. */
    private readonly always: string,
  ) {}

  escape(char: string, next: string, lineStart: boolean): string {
    // Перевод строки, за которым пробел или таб: разбор срезает отступ
    // строки, а экранированный пробел — уже не отступ.
    if (char === "\n" && (next === " " || next === "\t")) return "\n\\";
    return this.special(char, next, lineStart) ? `\\${char}` : char;
  }

  inLink(): Escaping {
    return IN_LINK;
  }

  private special(char: string, next: string, lineStart: boolean): boolean {
    if (this.always.includes(char)) return true;
    if (PAIRED.includes(char)) return next === char;
    return char === ">" && lineStart;
  }
}

/** Символы, удвоение которых — тег: `**`, `__`, `--`, `~~`, `||`. */
const PAIRED = "*_-~|";

const PLAIN: Escaping = new TextEscaping("\\`[");

/** В словах ссылки ещё и `]`: он закрыл бы слова раньше времени. */
const IN_LINK: Escaping = new TextEscaping("\\`[]");

/** Внутри кода разбор толкует только экранирование и закрывающую кавычку. */
const VERBATIM: Escaping = {
  escape: (char) => ("\\`".includes(char) ? `\\${char}` : char),
  inLink: () => VERBATIM,
};

/** Вид разметки: теги вокруг текста и правило экранирования внутри. */
interface Markup {
  readonly open: string;
  readonly close: string;
  inside(outer: Escaping): Escaping;
}

/** Удвоенный символ из `PAIRED` вокруг текста; правило не меняется. */
function paired(char: string): Markup {
  const tag = char.repeat(2);
  return { open: tag, close: tag, inside: (outer) => outer };
}

const BOLD = paired("*");
const ITALIC = paired("_");
const UNDERLINE = paired("-");
const STRIKE = paired("~");
const SPOILER = paired("|");

/** Вид без формы в диалекте (хэштег, голый адрес, `@name`): текст как есть. */
const AS_IS: Markup = { open: "", close: "", inside: (outer) => outer };

const CODE: Markup = { open: "`", close: "`", inside: () => VERBATIM };

function pre(language: string): Markup {
  return {
    open: `\`\`\`${language}\n`,
    close: "\n```",
    inside: () => VERBATIM,
  };
}

/** Ссылка под словами; разбор кончает адрес на `)`. */
function link(address: string): Markup {
  return {
    open: "[",
    close: `](${address.replace(/[\\)]/g, (char) => `\\${char}`)})`,
    inside: (outer) => outer.inLink(),
  };
}

/** Вид разметки по сущности протокола — граница контракта tl. */
function markupOf(entity: tl.TypeMessageEntity): Markup {
  switch (entity._) {
    case "messageEntityBold":
      return BOLD;
    case "messageEntityItalic":
      return ITALIC;
    case "messageEntityUnderline":
      return UNDERLINE;
    case "messageEntityStrike":
      return STRIKE;
    case "messageEntitySpoiler":
      return SPOILER;
    case "messageEntityCode":
      return CODE;
    case "messageEntityPre":
      return pre(entity.language);
    case "messageEntityTextUrl":
      return link(entity.url);
    case "messageEntityMentionName":
      return link(`tg://user?id=${entity.userId}`);
    default:
      return AS_IS;
  }
}

/** Разметка на отрезке видимого текста, в единицах UTF-16. */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly markup: Markup;
}

/** Кусок вывода: тег как есть либо символ текста под своим правилом. */
interface Piece {
  /** Кусок в выводе; `next` — первый символ уже собранного хвоста. */
  write(next: string): string;
}

function tagPiece(written: string): Piece {
  return { write: () => written };
}

function charPiece(text: string, at: number, escaping: Escaping): Piece {
  const lineStart = at === 0 || text[at - 1] === "\n";
  return { write: (next) => escaping.escape(text[at], next, lineStart) };
}

/**
 * Markdown-строка сообщения: видимый текст и разметка протокола.
 * Вложенные теги открываются «внешний первым», закрываются в обратном
 * порядке; виды без формы в диалекте остаются видимым текстом.
 */
export function markdown(
  text: string,
  entities: readonly tl.TypeMessageEntity[],
): string {
  return render(pieces(text, spans(entities)));
}

/**
 * Отрезки в порядке открытия: раньше начавшийся, при равном начале —
 * длинный (внешний). Пустой отрезок тега не даёт — разбор его не вернёт.
 */
function spans(entities: readonly tl.TypeMessageEntity[]): readonly Span[] {
  return entities
    .filter((entity) => entity.length > 0)
    .map((entity) => ({
      start: entity.offset,
      end: entity.offset + entity.length,
      markup: markupOf(entity),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Текст и теги в порядке вывода. */
function pieces(text: string, ordered: readonly Span[]): Piece[] {
  const out: Piece[] = [];
  let open: readonly Span[] = [];
  for (let at = 0; at <= text.length; at += 1) {
    const closing = open.filter((span) => span.end === at);
    for (const span of closing.toReversed()) {
      out.push(tagPiece(span.markup.close));
    }
    open = open.filter((span) => span.end !== at);
    for (const span of ordered.filter((span) => span.start === at)) {
      out.push(tagPiece(span.markup.open));
      open = [...open, span];
    }
    if (at === text.length) break;
    const rule = open.reduce((outer, span) => span.markup.inside(outer), PLAIN);
    out.push(charPiece(text, at, rule));
  }
  return out;
}

/**
 * Сборка справа налево: символ решает об экранировании по уже собранному
 * хвосту, а в нём экранированный сосед пару уже разбил.
 */
function render(ordered: readonly Piece[]): string {
  const out: string[] = [];
  let next = "";
  for (const piece of ordered.toReversed()) {
    const written = piece.write(next);
    // Пустой тег вида без формы соседом не считается: пару решает символ
    // за ним.
    if (written === "") continue;
    out.push(written);
    next = written[0];
  }
  return out.reverse().join("");
}
