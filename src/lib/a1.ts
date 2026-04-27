export class A1ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A1ParseError';
  }
}

const COL_RE = /^[A-Za-z]+$/;
const CELL_RE = /^([A-Za-z]+)(\d+)$/;

export function colA1ToNum(letters: string): number {
  if (!letters || !COL_RE.test(letters)) {
    throw new A1ParseError(`invalid A1 column "${letters}"`);
  }
  const upper = letters.toUpperCase();
  let n = 0;
  for (const ch of upper) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

export function colNumToA1(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new A1ParseError(`invalid column number ${n}`);
  }
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export interface A1Range {
  sheet: string;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  wholeSheet: boolean;
}

export function parseA1(input: string): A1Range {
  const bang = input.indexOf('!');
  let sheet: string;
  let rangeText: string;
  if (bang < 0) {
    sheet = unquote(input);
    return { sheet, r1: 0, c1: 0, r2: 0, c2: 0, wholeSheet: true };
  }
  sheet = unquote(input.slice(0, bang));
  rangeText = input.slice(bang + 1);
  if (!rangeText) throw new A1ParseError(`empty range after "!" in "${input}"`);

  const [a, b] = rangeText.includes(':') ? rangeText.split(':') : [rangeText, rangeText];
  if (!a || !b) throw new A1ParseError(`invalid A1 range "${input}"`);
  const start = parseCell(a, input);
  const end = parseCell(b, input);
  const r1 = Math.min(start.row, end.row);
  const r2 = Math.max(start.row, end.row);
  const c1 = Math.min(start.col, end.col);
  const c2 = Math.max(start.col, end.col);
  return { sheet, r1, c1, r2, c2, wholeSheet: false };
}

function parseCell(s: string, full: string): { row: number; col: number } {
  const m = CELL_RE.exec(s);
  if (!m) {
    throw new A1ParseError(
      `cannot parse cell "${s}" in range "${full}". Expected like "A1" or "BC123" — ` +
        `column-only ranges (e.g. "A:A") are not supported.`,
    );
  }
  return { row: Number.parseInt(m[2]!, 10), col: colA1ToNum(m[1]!) };
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}
