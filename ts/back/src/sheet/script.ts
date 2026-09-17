/**
 * Лексика мини-языка пакетных операций (`docs/specs/sheet-batch.md`,
 * «Инструкции»): деление скрипта на инструкции и инструкции на токены.
 *
 * Отдельно от компиляции, потому что правила здесь свои и ни на что не
 * смотрят: скобки, кавычки и комментарии решаются до того, как станет
 * известен глагол. Формула с `;` внутри `(…)` и блок `@kind {…}`
 * обязаны доехать до компилятора целыми — этим и заняты обе функции.
 */

import { UsageError } from "../command/mod.ts";

/** Одна инструкция скрипта: текст и её порядковый номер. */
export interface Instruction {
  /** Текст без окружающих пробелов; пустых инструкций в списке нет. */
  readonly text: string;
  /** Номер для префикса `строка N: `; считается по непустым. */
  readonly line: number;
}

/** Открывающие скобки, наращивающие глубину. */
const OPEN = "([{";
/** Закрывающие; лишняя закрывающая не уводит глубину ниже нуля. */
const CLOSE = ")]}";

/**
 * Делит скрипт на инструкции. Разделитель — перевод строки или `;` на
 * глубине скобок 0 вне кавычек; `#` на границе токена на глубине 0 —
 * комментарий до конца строки (поэтому `bg=#fff` комментарием не
 * становится: `#` там прижат к `=`).
 */
export function splitScript(source: string): readonly Instruction[] {
  const out: Instruction[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  let boundary = true;
  const flush = () => {
    const text = current.trim();
    if (text !== "") out.push({ text, line: out.length + 1 });
    current = "";
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote !== undefined) {
      current += char;
      // `\x` внутри кавычек — экранированный символ: следующий символ
      // берётся как есть и кавычку не закрывает.
      if (char === "\\" && index + 1 < source.length) {
        current += source[++index];
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      boundary = false;
      continue;
    }
    if (char === "#" && depth === 0 && boundary) {
      while (index < source.length && source[index] !== "\n") index++;
      flush();
      continue;
    }
    if (char === "\n" || (char === ";" && depth === 0)) {
      flush();
      boundary = true;
      continue;
    }
    if (OPEN.includes(char)) depth++;
    else if (CLOSE.includes(char) && depth > 0) depth--;
    current += char;
    boundary = char === " " || char === "\t";
  }
  flush();
  return out;
}

/**
 * Делит инструкцию на токены по пробелам. Кавычки защищают пробелы и
 * **остаются** в токене: снимает их тот, кто ждёт строку, — иначе
 * `set A1 '5'` было бы не отличить от `set A1 5`, а первое обязано
 * остаться строкой.
 *
 * Токен, начатый `{`, — цельный сбалансированный блок: тело `@kind {…}`
 * содержит и пробелы, и переводы строк, и делить его нечем.
 */
export function tokenize(text: string): readonly string[] {
  const out: string[] = [];
  let current = "";
  let index = 0;
  const flush = () => {
    if (current !== "") out.push(current);
    current = "";
  };
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\n") {
      flush();
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      const quoted = readQuoted(text, index, char);
      current += quoted;
      index += quoted.length;
      continue;
    }
    if (char === "{") {
      flush();
      const block = readBlock(text, index);
      out.push(block);
      index += block.length;
      continue;
    }
    current += char;
    index++;
  }
  flush();
  return out;
}

/** Кусок в кавычках вместе с кавычками; незакрытая — до конца текста. */
function readQuoted(text: string, start: number, quote: string): string {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 2;
      continue;
    }
    index++;
    if (char === quote) break;
  }
  return text.slice(start, index);
}

/** Сбалансированный `{…}`-блок; незакрытый — ошибка ввода. */
function readBlock(text: string, start: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new UsageError("незакрытый блок '{'");
}

/**
 * Снимает кавычки с токена, если он ими окружён, и раскрывает `\x`.
 * Не в кавычках — токен как есть: значение решает не эта функция.
 */
export function unquote(token: string): string {
  const quote = token[0];
  if ((quote !== "'" && quote !== '"') || !token.endsWith(quote)) return token;
  if (token.length < 2) return token;
  const body = token.slice(1, -1);
  let out = "";
  for (let index = 0; index < body.length; index++) {
    if (body[index] === "\\" && index + 1 < body.length) {
      out += body[++index];
      continue;
    }
    out += body[index];
  }
  return out;
}

/** Был ли токен записан в кавычках: строкой он остаётся при любом виде. */
export function isQuoted(token: string): boolean {
  const quote = token[0];
  return (quote === "'" || quote === '"') && token.length >= 2 &&
    token.endsWith(quote);
}
