/**
 * Разбор исходника `.d2` — то подмножество языка, которое команда
 * действительно понимает (`docs/specs/d2-miro.md`, «Поддерживаемое
 * подмножество D2», снято 2026-08-31).
 *
 * Граница разбора взята с живого замера, а не придумана: **имя шейпа
 * читается как `[a-zA-Z_]\w*`, метка — только из кавычек**. Имя вне
 * этого класса (кириллица) объявлением не считается, и шейп потом
 * приходит из SVG без вида и без стиля — фикстура-контрпример
 * `sample-cyrillic.d2` ровно про это.
 *
 * У рёбер граница шире: имена берутся как написаны, метка — из хвоста
 * после двоеточия, в кавычках или без. Так ведёт себя объект, и
 * фикстура это показывает: у кириллического входа шейпов нет, а ребро
 * с меткой есть.
 */

/** Вид шейпа в исходнике; `rectangle` — умолчание. */
export type D2Kind = string;

/** Объявленный шейп: имя с точками — вложенность (контейнеры). */
export interface D2Shape {
  readonly name: string;
  readonly kind: D2Kind;
  /** Метка из кавычек; нет — рисуется имя. */
  readonly label?: string;
  readonly fill?: string;
  readonly stroke?: string;
  /** `class: card` — карточка, рисуется скруглённым прямоугольником. */
  readonly card: boolean;
}

/** Ребро: имена как написаны в исходнике, метка — хвост после `:`. */
export interface D2Edge {
  readonly src: string;
  readonly dst: string;
  readonly label: string;
}

/** Markdown-блок `имя: |md … |`: у него нет layout'а в SVG. */
export interface D2Markdown {
  readonly name: string;
  readonly text: string;
}

/** Разобранный исходник. */
export interface D2Source {
  readonly shapes: readonly D2Shape[];
  readonly edges: readonly D2Edge[];
  readonly markdown: readonly D2Markdown[];
}

/** Имя объявления — только оно и означает «шейп объявлен». */
const NAME = "[a-zA-Z_]\\w*";
const DECLARATION = new RegExp(`^(${NAME})\\s*:\\s*(.*)$`);
const MARKDOWN_OPEN = new RegExp(`^(${NAME})\\s*:\\s*\\|md\\s*$`);
/** Ребро: имена как написаны — разбор шире, чем у объявления. */
const EDGE = /^(\S+)\s*->\s*([^:{}]+?)\s*(?::\s*(.*))?$/;

/** Строка `ключ: значение` внутри блока шейпа. */
const ATTRIBUTE = /^([a-z][a-z.]*)\s*:\s*(.*)$/;

/** Снимает кавычки, если значение в них целиком. */
function unquoted(value: string): string {
  const text = value.trim();
  const quoted = /^"([^"]*)"$/.exec(text);
  return quoted === null ? text : quoted[1];
}

/** Изменяемая запись шейпа: собирается по мере чтения блока. */
interface Draft {
  name: string;
  kind: string;
  label?: string;
  fill?: string;
  stroke?: string;
  card: boolean;
}

/** Полное имя внутри контейнеров: `recalc` + `check` → `recalc.check`. */
function qualified(stack: readonly (string | null)[], name: string): string {
  return [...stack.filter((item) => item !== null), name].join(".");
}

/**
 * Разбирает исходник. Ошибок не бросает: непонятая строка — не отказ,
 * а молчание, и последствия видно сверкой имён с SVG (`plan.ts`).
 * Отказывать здесь значило бы отказывать на любом синтаксисе D2, до
 * которого перенос ещё не дошёл.
 */
export function parseD2(text: string): D2Source {
  const shapes: Draft[] = [];
  const edges: D2Edge[] = [];
  const markdown: D2Markdown[] = [];
  // В стеке лежит имя открытого блока либо `null` — блок, чьё
  // объявление разбор не понял (кириллическое имя). Внутри такого
  // блока не объявляется ничего: полное имя ребёнка было бы
  // выдуманным, а свойства некуда класть. Считать скобки всё равно
  // надо — иначе `}` закрыл бы чужой блок и разбор поехал бы дальше
  // со сдвигом.
  const stack: (string | null)[] = [];
  const byName = new Map<string, Draft>();
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const body = lines[i].replace(/#.*$/, "").trim();
    if (body === "") continue;
    if (body === "}") {
      stack.pop();
      continue;
    }
    const inside = stack.length === 0 ? undefined : stack[stack.length - 1];
    const lost = stack.includes(null);
    const md = MARKDOWN_OPEN.exec(body);
    if (md !== null && !lost) {
      i = readMarkdown(lines, i, qualified(stack, md[1]), markdown);
      continue;
    }
    const edge = EDGE.exec(body);
    if (edge !== null) {
      edges.push({
        src: qualified(stack, edge[1]),
        dst: qualified(stack, edge[2]),
        label: edge[3] === undefined ? "" : unquoted(edge[3]),
      });
      continue;
    }
    const opens = body.trimEnd().endsWith("{");
    const declaration = DECLARATION.exec(body);
    if (declaration === null) {
      // Непонятое объявление: блок всё равно открыт, и внутри него
      // объявлять нечего.
      if (opens) stack.push(null);
      continue;
    }
    const [, name, rest] = declaration;
    const target = inside === undefined || inside === null
      ? undefined
      : byName.get(inside);
    if (target !== undefined && !opens && applyAttribute(target, name, rest)) {
      continue;
    }
    if (lost) {
      if (opens) stack.push(null);
      continue;
    }
    const draft = declare(qualified(stack, name), rest);
    shapes.push(draft);
    byName.set(draft.name, draft);
    if (opens) stack.push(name);
  }

  return { shapes, edges, markdown };
}

/** Новый шейп из строки объявления: метка — только из кавычек. */
function declare(name: string, rest: string): Draft {
  const head = rest.replace(/\{\s*$/, "").trim();
  const quoted = /^"([^"]*)"$/.exec(head);
  return {
    name,
    kind: "rectangle",
    label: quoted === null ? undefined : quoted[1],
    card: false,
  };
}

/**
 * Строка внутри блока — свойство шейпа, а не вложенный шейп. Список
 * закрытый: `shape`, `style.fill`, `style.stroke`, `class`. Возвращает
 * `true`, если строка была свойством и шейпом её считать не нужно.
 */
function applyAttribute(target: Draft, name: string, rest: string): boolean {
  const attribute = ATTRIBUTE.exec(`${name}: ${rest}`);
  if (attribute === null) return false;
  const [, key, raw] = attribute;
  const value = unquoted(raw);
  if (key === "shape") {
    target.kind = value;
    return true;
  }
  if (key === "style.fill") {
    target.fill = value;
    return true;
  }
  if (key === "style.stroke") {
    target.stroke = value;
    return true;
  }
  if (key === "class") {
    target.card = value === "card";
    return true;
  }
  return false;
}

/** Тело markdown-блока до закрывающей `|`; возвращает индекс её строки. */
function readMarkdown(
  lines: readonly string[],
  open: number,
  name: string,
  into: D2Markdown[],
): number {
  const body: string[] = [];
  let i = open + 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "|") break;
    body.push(lines[i].trim());
  }
  into.push({ name, text: body.join("\n") });
  return i;
}
