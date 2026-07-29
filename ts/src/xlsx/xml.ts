/**
 * Минимальный XML-ридер под словарь OOXML: дерево элементов с
 * атрибутами и текстом, сущности, CDATA, комментарии. Пространства
 * имён не разрешаются — префикс имени элемента отбрасывается, атрибуты
 * ищутся по локальному имени (`attr`). Ошибки формата собирают деталь
 * для сообщения «malformed XML: …» из спеки. Свой ридер, потому что в
 * Deno нет встроенного XML-парсера, а нужное подмножество невелико.
 */

/** Текстовый узел — строка; элемент — `XmlElement`. */
export type XmlNode = XmlElement | string;

/** Элемент дерева: имя, атрибуты и дочерние узлы по порядку. */
export interface XmlElement {
  /** Локальное имя, без префикса пространства имён. */
  readonly name: string;
  /** Атрибуты с именами как в документе (включая префиксы). */
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
}

/** Ошибка формата; message — деталь для «malformed XML: <детали>». */
export class XmlError extends Error {
  override name = "XmlError";
}

/** Разбирает документ и возвращает корневой элемент. */
export function parseXml(text: string): XmlElement {
  const parser = new Parser(text);
  parser.skipMisc();
  if (parser.done() || !parser.at("<")) {
    throw new XmlError("no root element");
  }
  const root = parser.parseElement();
  parser.skipMisc();
  if (!parser.done()) {
    throw new XmlError(
      `unexpected content after the root element at offset ${parser.pos}`,
    );
  }
  return root;
}

/** Значение атрибута по локальному имени (`r:id` находится по `id`). */
export function attr(el: XmlElement, localName: string): string | undefined {
  for (const [name, value] of el.attrs) {
    if (name === localName || name.endsWith(`:${localName}`)) return value;
  }
  return undefined;
}

/** Прямые дочерние элементы с данным локальным именем. */
export function children(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of el.children) {
    if (typeof child !== "string" && child.name === name) out.push(child);
  }
  return out;
}

/** Первый прямой дочерний элемент с данным локальным именем. */
export function firstChild(
  el: XmlElement,
  name: string,
): XmlElement | undefined {
  for (const child of el.children) {
    if (typeof child !== "string" && child.name === name) return child;
  }
  return undefined;
}

/** Конкатенация всех текстовых узлов поддерева, без обрезки пробелов. */
export function textContent(el: XmlElement): string {
  let out = "";
  for (const child of el.children) {
    out += typeof child === "string" ? child : textContent(child);
  }
  return out;
}

const NAME_END = new Set([..." \t\r\n/>=\"'<"]);

class Parser {
  pos = 0;
  private readonly text: string;

  constructor(text: string) {
    // XML 1.0 §2.11: парсер обязан привести \r\n и одиночный \r к \n
    // (ссылка &#xD; не затрагивается — она декодируется позже).
    this.text = text.replace(/\r\n?/g, "\n");
  }

  done(): boolean {
    return this.pos >= this.text.length;
  }

  at(prefix: string): boolean {
    return this.text.startsWith(prefix, this.pos);
  }

  /** Пропускает пробелы, комментарии, PI и DOCTYPE между элементами. */
  skipMisc(): void {
    for (;;) {
      while (!this.done() && " \t\r\n﻿".includes(this.text[this.pos])) {
        this.pos++;
      }
      if (this.at("<!--")) this.skipUntil("-->");
      else if (this.at("<?")) this.skipUntil("?>");
      else if (this.at("<!DOCTYPE")) this.skipUntil(">");
      else return;
    }
  }

  parseElement(): XmlElement {
    this.pos++; // «<»
    const name = this.readName("element name");
    const attrs = this.parseAttrs();
    if (this.at("/>")) {
      this.pos += 2;
      return { name: localName(name), attrs, children: [] };
    }
    this.expect(">");
    const childNodes = this.parseContent(name);
    return { name: localName(name), attrs, children: childNodes };
  }

  private parseAttrs(): Map<string, string> {
    const attrs = new Map<string, string>();
    for (;;) {
      this.skipWs();
      if (this.done()) throw this.eof();
      if (this.at(">") || this.at("/>")) return attrs;
      const name = this.readName("attribute name");
      this.skipWs();
      this.expect("=");
      this.skipWs();
      const quote = this.text[this.pos];
      if (quote !== `"` && quote !== `'`) {
        throw new XmlError(
          `attribute "${name}" value must be quoted at offset ${this.pos}`,
        );
      }
      this.pos++;
      const end = this.text.indexOf(quote, this.pos);
      if (end < 0) throw this.eof();
      attrs.set(name, this.decodeEntities(this.text.slice(this.pos, end)));
      this.pos = end + 1;
    }
  }

  private parseContent(openName: string): XmlNode[] {
    const nodes: XmlNode[] = [];
    for (;;) {
      if (this.done()) throw this.eof();
      if (this.at("</")) {
        this.pos += 2;
        const name = this.readName("closing tag name");
        this.skipWs();
        this.expect(">");
        if (name !== openName) {
          throw new XmlError(
            `mismatched closing tag "</${name}>" at offset ${this.pos}, ` +
              `expected "</${openName}>"`,
          );
        }
        return nodes;
      }
      if (this.at("<!--")) this.skipUntil("-->");
      else if (this.at("<![CDATA[")) {
        this.pos += 9;
        const end = this.text.indexOf("]]>", this.pos);
        if (end < 0) throw this.eof();
        nodes.push(this.text.slice(this.pos, end));
        this.pos = end + 3;
      } else if (this.at("<?")) this.skipUntil("?>");
      else if (this.at("<")) nodes.push(this.parseElement());
      else {
        let end = this.text.indexOf("<", this.pos);
        if (end < 0) end = this.text.length;
        nodes.push(this.decodeEntities(this.text.slice(this.pos, end)));
        this.pos = end;
      }
    }
  }

  private decodeEntities(raw: string): string {
    if (!raw.includes("&")) return raw;
    let out = "";
    let pos = 0;
    for (;;) {
      const amp = raw.indexOf("&", pos);
      if (amp < 0) return out + raw.slice(pos);
      out += raw.slice(pos, amp);
      const semi = raw.indexOf(";", amp + 1);
      if (semi < 0) {
        throw new XmlError(`unterminated entity at offset ${this.pos}`);
      }
      // Ограничение против «;» из далёкого текста; валидные ссылки
      // (включая ведущие нули) заметно короче.
      if (semi - amp > 32) {
        throw new XmlError(`invalid entity at offset ${this.pos}`);
      }
      const body = raw.slice(amp + 1, semi);
      out += decodeEntity(body, this.pos);
      pos = semi + 1;
    }
  }

  private readName(what: string): string {
    const start = this.pos;
    while (!this.done() && !NAME_END.has(this.text[this.pos])) this.pos++;
    if (this.pos === start) {
      if (this.done()) throw this.eof();
      throw new XmlError(`missing ${what} at offset ${this.pos}`);
    }
    return this.text.slice(start, this.pos);
  }

  private expect(token: string): void {
    if (this.done()) throw this.eof();
    if (!this.at(token)) {
      throw new XmlError(`expected "${token}" at offset ${this.pos}`);
    }
    this.pos += token.length;
  }

  private skipWs(): void {
    while (!this.done() && " \t\r\n".includes(this.text[this.pos])) this.pos++;
  }

  private skipUntil(terminator: string): void {
    const end = this.text.indexOf(terminator, this.pos);
    if (end < 0) throw this.eof();
    this.pos = end + terminator.length;
  }

  private eof(): XmlError {
    return new XmlError("unexpected end of input");
  }
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: `"`,
  apos: "'",
};

function decodeEntity(body: string, offset: number): string {
  const named = NAMED_ENTITIES[body];
  if (named !== undefined) return named;
  if (body.startsWith("#")) {
    const digits = body.slice(1);
    const hex = /^[xX]([0-9a-fA-F]+)$/.exec(digits);
    const code = hex !== null
      ? Number.parseInt(hex[1], 16)
      : /^\d+$/.test(digits)
      ? Number.parseInt(digits, 10)
      : Number.NaN;
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
      throw new XmlError(
        `invalid character entity "&${body};" near offset ${offset}`,
      );
    }
    return String.fromCodePoint(code);
  }
  throw new XmlError(`unknown entity "&${body};" near offset ${offset}`);
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(colon + 1);
}
