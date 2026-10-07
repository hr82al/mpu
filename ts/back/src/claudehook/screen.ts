/**
 * Блок диалога на снятом экране tmux (`claude-hook-notification-snapshot.md`,
 * «Вопрос-снимок»): что из окна Claude Code показать владельцу в Telegram.
 * Экран — чужой формат: строки разбираются здесь и только здесь, правила
 * держатся на экранах, снятых живьём (`testdata/snapshot/`).
 */

import { clipLabel } from "../botquestions/mod.ts";

/** Сплошная линия: не короче — иначе это не рамка диалога. */
const RULE_MIN = 20;

/** Подсказки клавиш под диалогом — их кнопки бот даёт свои. */
const HINTS: readonly string[] = [
  "Esc to cancel",
  "Enter to select",
  "Enter to confirm",
  "↑/↓ to navigate",
];

/** Маркер выбранной строки Claude Code. */
const CURSOR = "❯ ";

/** Строка экрана по виду — граница разбора. */
type Row =
  | { readonly kind: "rule" }
  | { readonly kind: "line" }
  | { readonly kind: "blank" }
  | { readonly kind: "hint" }
  | {
      readonly kind: "item";
      readonly number: number;
      readonly text: string;
      readonly indent: number;
    }
  | { readonly kind: "text"; readonly text: string; readonly indent: number };

/** Вид строки экрана. */
function rowOf(raw: string): Row {
  const line = raw.trimEnd();
  const bare = line.trim();
  if (bare === "") return { kind: "blank" };
  if (/^[─╌═]+$/.test(bare)) {
    return /^─+$/.test(bare) && bare.length >= RULE_MIN
      ? { kind: "rule" }
      : { kind: "line" };
  }
  // Рамка с именем окна (`─── probe ─`): линия, а не текст и не начало.
  if (/^[─╌═]{3,} .+ [─╌═]+$/.test(bare)) return { kind: "line" };
  let indent = line.length - line.trimStart().length;
  let body = line.trimStart();
  // Маркер выбора — `❯` с пробелом или один (пустое поле ввода после
  // обрезки хвостовых пробелов).
  if (body.startsWith(CURSOR.trim())) {
    const marker = body.startsWith(CURSOR) ? CURSOR : CURSOR.trim();
    body = body.slice(marker.length);
    indent += CURSOR.length;
    if (body === "") return { kind: "blank" };
  }
  if (body.startsWith("Tip:") || HINTS.some((hint) => body.startsWith(hint))) {
    return { kind: "hint" };
  }
  const item = /^([1-9])\. (.*)$/.exec(body);
  if (item !== null) {
    return { kind: "item", number: Number(item[1]), text: item[2], indent };
  }
  return { kind: "text", text: body, indent };
}

/** Строка — содержимое (не линия и не пустая). */
function content(row: Row): boolean {
  return row.kind !== "rule" && row.kind !== "line" && row.kind !== "blank";
}

/**
 * Линия внутри списка пунктов (AskUserQuestion отделяет так последний
 * пункт): за ней сразу пункт `N.` (N > 1), а выше, до прежней линии, уже
 * есть пункты. Начало блока — не она: иначе блок был бы одним пунктом.
 */
function separates(rows: readonly Row[], at: number): boolean {
  const next = rows.slice(at + 1).find((row) => row.kind !== "blank");
  if (next?.kind !== "item" || next.number < 2) return false;
  const above = rows.slice(0, at);
  const from = above.findLastIndex((row) => row.kind === "rule") + 1;
  return above.slice(from).some((row) => row.kind === "item");
}

/**
 * Начало блока: строка после последней сплошной линии, под которой есть
 * содержимое, кроме линий внутри списка пунктов. Такой нет — блока нет.
 */
function blockOf(rows: readonly Row[]): readonly Row[] {
  for (let at = rows.length - 1; at >= 0; at--) {
    if (rows[at].kind !== "rule") continue;
    if (!rows.slice(at + 1).some(content)) continue;
    if (separates(rows, at)) continue;
    return rows.slice(at + 1);
  }
  return [];
}

/** Пункт диалога: номер нажимаемой клавиши и подпись кнопки. */
export interface Item {
  readonly number: number;
  readonly label: string;
}

/** Блок диалога, ужатый для телефона. */
export class Dialog {
  readonly #lines: readonly string[];
  readonly #items: readonly Item[];
  readonly #waiting: boolean;

  constructor(
    lines: readonly string[],
    items: readonly Item[],
    waiting: boolean,
  ) {
    this.#lines = [...lines];
    this.#items = [...items];
    this.#waiting = waiting;
  }

  /** Строки тела. */
  lines(): readonly string[] {
    return [...this.#lines];
  }

  /** Пункты по порядку. */
  items(): readonly Item[] {
    return [...this.#items];
  }

  /** Диалог ждёт ответа: есть пункты или подсказки клавиш. */
  waiting(): boolean {
    return this.#waiting;
  }

  /** Первая строка блока; блока нет — `лента`. */
  firstLine(): string {
    return this.#lines[0] ?? "лента";
  }

  /** Тело одной строкой. */
  text(): string {
    return this.#lines.join("\n");
  }

  /** Тот же блок (ответили в терминале — блок другой). */
  same(other: Dialog): boolean {
    return this.text() === other.text() && this.#waiting === other.#waiting;
  }
}

/** Подпись кнопки пункта: до « · », не длиннее 60. */
function labelOf(number: number, text: string): string {
  return clipLabel(`${number}. ${text.split(" · ")[0]}`);
}

/** Блок диалога экрана `screen` (вывод `capture-pane -p`). */
export function dialogOf(screen: string): Dialog {
  const rows = blockOf(screen.split("\n").map(rowOf));
  const lines: string[] = [];
  const items: Item[] = [];
  let waiting = false;
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at];
    if (row.kind === "hint") waiting = true;
    if (row.kind === "text") lines.push(row.text);
    if (row.kind !== "item") continue;
    waiting = true;
    items.push({ number: row.number, label: labelOf(row.number, row.text) });
    // Описание пункта — следующая строка текста с отступом глубже.
    const next = rows[at + 1];
    if (next?.kind === "text" && next.indent > row.indent) {
      lines.push(`${row.number}. ${row.text} — ${next.text}`);
      at += 1;
      continue;
    }
    lines.push(`${row.number}. ${row.text}`);
  }
  return new Dialog(lines, items, waiting);
}
