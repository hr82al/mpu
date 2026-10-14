/**
 * Патч `git diff -U0`: по файлу новой стороны — куски, каждый со своими
 * строками и отрезками текста рабочего дерева. Разбор один на всех, кто
 * спрашивает о диффе (`--base` у `code literals`, `code shape` и
 * `code twins`).
 *
 * Строки куска забираются по счёту из его заголовка, а не по первому
 * символу: в `-U0` строка содержимого `---` (удалённый `--`) выглядит
 * как заголовок следующего файла.
 */

/** Место в тексте файла: строка с единицы, столбец UTF-16 с нуля — как у компилятора. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/**
 * Отрезок текста файла: от `start` включительно до `end` не включая.
 * Пустой отрезок — место между двумя символами (там, где удалено).
 */
export interface TextSpan {
  readonly start: Position;
  readonly end: Position;
}

/** Задеты ли два отрезка друг другом: пересекаются или место внутри. */
function overlaps(a: TextSpan, b: TextSpan): boolean {
  return before(a.start, b.end) && before(b.start, a.end);
}

function before(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.column < b.column);
}

/** Кусок диффа: что он изменил в рабочем дереве. */
export class Hunk {
  /**
   * `first`, `count` — строки новой стороны; `changed` — изменённые
   * отрезки текста на ней.
   */
  constructor(
    private readonly first: number,
    private readonly count: number,
    private readonly changed: readonly TextSpan[],
  ) {}

  /** Строки рабочего дерева куска; у чистого удаления их нет. */
  lines(): readonly number[] {
    return Array.from({ length: this.count }, (_, i) => this.first + i);
  }

  /** Задевает ли кусок отрезок текста рабочего дерева. */
  touches(span: TextSpan): boolean {
    return this.changed.some((changed) => overlaps(changed, span));
  }
}

/**
 * Изменённые отрезки куска. Вид куска — данные разбора, решаются здесь
 * один раз: чистое удаление — место между строками; замена поровну —
 * изменённые столбцы каждой пары строк; прочее — новые строки целиком.
 */
function changedSpans(
  first: number,
  removed: readonly string[],
  added: readonly string[],
): readonly TextSpan[] {
  if (added.length === 0) {
    // `+N,0`: удалённое стоит между строками `N` и `N + 1`.
    const gap = { line: first + 1, column: 0 };
    return [{ start: gap, end: gap }];
  }
  if (removed.length === added.length) {
    return added.map((text, i) => rewritten(first + i, removed[i], text));
  }
  return [
    {
      start: { line: first, column: 0 },
      end: { line: first + added.length, column: 0 },
    },
  ];
}

/**
 * Изменённые столбцы строки `line`: между общим началом и общим концом
 * прежней и новой строки. Переименование функции на строке `{` меняет
 * столбцы левее скобки и тела не задевает.
 */
function rewritten(line: number, was: string, now: string): TextSpan {
  const limit = Math.min(was.length, now.length);
  let head = 0;
  while (head < limit && was[head] === now[head]) head++;
  let tail = 0;
  while (
    tail < limit - head &&
    was[was.length - 1 - tail] === now[now.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    start: { line, column: head },
    end: { line, column: now.length - tail },
  };
}

/** Патч одного файла: путь новой стороны и куски. */
export class FilePatch {
  readonly #hunks: Hunk[] = [];

  constructor(readonly path: string) {}

  add(hunk: Hunk): void {
    this.#hunks.push(hunk);
  }

  /** Строки рабочего дерева, которые поставили куски. */
  lines(): readonly number[] {
    return this.#hunks.flatMap((hunk) => hunk.lines());
  }

  /** Задет ли отрезок текста хоть одним куском. */
  touches(span: TextSpan): boolean {
    return this.#hunks.some((hunk) => hunk.touches(span));
  }
}

/** Заголовок куска: `@@ -начало[,число] +начало[,число] @@`. */
const HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Путь новой стороны: `+++ b/путь`; у удалённого файла — `/dev/null`. */
const NEW_SIDE = "+++ ";

/** Строка-примечание `\ No newline at end of file` в счёт куска не входит. */
const NOTE = "\\";

/** Читает патч `git diff -U0` по файлам новой стороны. */
export function readPatch(text: string): readonly FilePatch[] {
  const lines = text.split("\n");
  const files: FilePatch[] = [];
  // Куски до первого заголовка файла (их у git не бывает) уходят в
  // патч, которого нет в ответе.
  let file = new FilePatch("");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index++];
    if (line.startsWith(NEW_SIDE)) {
      file = new FilePatch(newPath(line.slice(NEW_SIDE.length)));
      files.push(file);
      continue;
    }
    const header = HEADER.exec(line);
    if (header === null) continue;
    const [, removed, start, added] = header;
    // Без числа сторона куска — одна строка.
    const body = hunkBody(
      lines,
      index,
      removed === undefined ? 1 : Number(removed),
      added === undefined ? 1 : Number(added),
    );
    index = body.next;
    file.add(
      new Hunk(
        Number(start),
        body.added.length,
        changedSpans(Number(start), body.removed, body.added),
      ),
    );
  }
  return files;
}

/** Содержимое куска: удалённые и добавленные строки без знака. */
interface HunkBody {
  readonly removed: readonly string[];
  readonly added: readonly string[];
  /** Индекс строки патча за куском. */
  readonly next: number;
}

/** Забирает строки куска по счёту заголовка. */
function hunkBody(
  lines: readonly string[],
  from: number,
  removing: number,
  adding: number,
): HunkBody {
  const removed: string[] = [];
  const added: string[] = [];
  let index = from;
  while (removed.length + added.length < removing + adding) {
    if (index >= lines.length) break;
    const line = lines[index++];
    if (line.startsWith(NOTE)) continue;
    (removed.length < removing ? removed : added).push(line.slice(1));
  }
  while (index < lines.length && lines[index].startsWith(NOTE)) index++;
  return { removed, added, next: index };
}

/**
 * Путь новой стороны без префикса `b/`. Путь со спецсимволами git
 * берёт в кавычки с экранированием языка C — его раскрывает `unquote`;
 * за путём с пробелом git ставит табуляцию (для `patch`), она не часть
 * пути.
 */
function newPath(header: string): string {
  const raw = header.endsWith("\t") ? header.slice(0, -1) : header;
  const path = raw.startsWith('"') ? unquote(raw) : raw;
  return path.startsWith("b/") ? path.slice(2) : path;
}

/** Экранирования git в пути в кавычках: `\"`, `\\`, `\t`, `\ooo`. */
const ESCAPE = /\\(?:([0-7]{3})|(.))/g;

/** Буквенные экранирования языка C. */
const NAMED: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/**
 * Раскрывает путь в кавычках. Восьмеричные — байты UTF-8, поэтому
 * собираются в байты и декодируются целиком, а не по символу.
 */
function unquote(raw: string): string {
  const inner = raw.slice(1, raw.lastIndexOf('"'));
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let last = 0;
  for (const match of inner.matchAll(ESCAPE)) {
    bytes.push(...encoder.encode(inner.slice(last, match.index)));
    const [whole, octal, char] = match;
    bytes.push(
      ...(octal === undefined
        ? encoder.encode(NAMED[char] ?? char)
        : [Number.parseInt(octal, 8)]),
    );
    last = match.index + whole.length;
  }
  bytes.push(...encoder.encode(inner.slice(last)));
  return new TextDecoder().decode(new Uint8Array(bytes));
}
