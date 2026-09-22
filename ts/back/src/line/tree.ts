/**
 * Дерево объектов из реестра команд (`platform/registry-objects.md`,
 * «Дерево»). Запись реестра переводится в вид узла здесь, один раз; дальше
 * узел отвечает сам — детьми, хвостом и своим концом строки.
 */

import { commandFlags, ROOT_SUMMARY, ROOT_USAGE } from "../entrypoint/mod.ts";
import {
  type Call,
  type Doc,
  type Ending,
  EVERYONE,
  type Fallback,
  foreignTail,
  gate,
  type Method,
  origin,
  Refusal,
  type Roster,
  Shape,
  type ShapeOptions,
  tail,
  unary,
} from "../objects/mod.ts";
import { PolicyError, type RuleBook } from "../policy/mod.ts";
import {
  childrenOf,
  type CommandGroup,
  findCommand,
  findGroup,
  findSurface,
  surfaces,
} from "../registry/mod.ts";
import type { Line } from "./dispatch.ts";
import { FOREIGN, type Order, OWN } from "./order.ts";
import { ruleMethods } from "./rules.ts";
import { ASK_DOC, ASK_WORD, DOOR, NORMAL, type View } from "./view.ts";

/** Вид звена хвоста: оно же звено пути строки у правил. */
export const ARGS = "<args>";

/** Как строится дерево для взгляда: чем кончать строку, кого называть. */
interface Sight {
  /** Конец строки у узла, который исполняется и собирает строку `order`. */
  ending(order: Order): Ending<Line>;
  /** Роспись детей узла `path`. */
  roster(path: readonly string[]): Roster;
}

/** Снимок дерева: структура без решений правил — все узлы, обычный конец. */
const WHOLE: Sight = {
  ending: (order) => ({
    finish: (report, line) => line.dispatch(report, NORMAL, order),
  }),
  roster: () => EVERYONE,
};

/**
 * Взгляд над книгой правил строки. Решения спрашиваются у книги на
 * каждый вопрос росписи: книга сама сверяется с файлом.
 */
class Seen implements Sight {
  readonly #view: View;
  readonly #book: RuleBook;
  #executing: readonly TreeNode[] | undefined;

  constructor(view: View, book: RuleBook) {
    this.#view = view;
    this.#book = book;
  }

  ending(order: Order): Ending<Line> {
    return {
      finish: (report, line) => line.dispatch(report, this.#view, order),
    };
  }

  roster(path: readonly string[]): Roster {
    return { lists: (selector) => this.#lists([...path, selector]) };
  }

  /**
   * Ребёнок реестра называется, если его поддерево исполняет хоть одну
   * строку по этому адресу; сообщения корня и поверхности — всегда.
   */
  #lists(path: readonly string[]): boolean {
    if (findCommand(path) === undefined && findGroup(path) === undefined) {
      return true;
    }
    return this.#under(path).some((node) => this.#admits(ruleLinks(node)));
  }

  /** Узлы поддерева `path`, которые исполняются сами (у них есть хвост). */
  #under(path: readonly string[]): TreeNode[] {
    this.#executing ??= registryNodes().filter((node) => node.tail !== null);
    return this.#executing.filter((node) =>
      path.every((link, i) => node.path[i] === link)
    );
  }

  #admits(links: readonly string[]): boolean {
    try {
      return this.#book.decide(links).admits(this.#view);
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      throw new Refusal(err.message, { cause: err });
    }
  }
}

/** Как лист берёт хвост и отдаёт строку диспетчеризации. */
interface TailKind {
  fallback(doc: Doc, kind: () => Shape<Line>): Fallback<Line>;
  readonly order: Order;
}

/** Свой хвост — до закрытия. */
const OWN_TAIL: TailKind = {
  fallback: (doc, kind) => tail(ARGS, doc, kind),
  order: OWN,
};

/** Чужой хвост (`ssh`) — до конца строки, как есть. */
const FOREIGN_TAIL: TailKind = {
  fallback: (doc, kind) => foreignTail(ARGS, doc, kind),
  order: FOREIGN,
};

/** Хвост листа: чужой у команды, чей вход забирает неопознанное. */
function tailKind(path: readonly string[]): TailKind {
  const inputs = findCommand(path)?.inputs ?? [];
  const foreign = inputs.some((input) => input.form.keepsUnknown === true);
  return foreign ? FOREIGN_TAIL : OWN_TAIL;
}

/** Вид, который забирает хвост и в конце строки исполняет её. */
function dispatching(
  doc: Doc,
  sight: Sight,
  kind: TailKind = OWN_TAIL,
): Shape<Line> {
  const shape: Shape<Line> = new Shape<Line>([], {
    fallback: kind.fallback(doc, () => shape),
    ending: sight.ending(kind.order),
  });
  return shape;
}

/** Вид узла группы: что она делает с чужим словом и с концом строки. */
interface GroupKind {
  options(doc: Doc, sight: Sight): ShapeOptions<Line>;
}

/** Только дети; конец строки — справка. */
const PLAIN: GroupKind = { options: () => ({}) };

/** Группа с селектором перед подкомандой: чужое слово начинает хвост. */
const SELECTOR_FIRST: GroupKind = {
  options: (doc, sight) => {
    const after = dispatching(doc, sight);
    return { fallback: tail(ARGS, doc, () => after) };
  },
};

function groupKind(group: CommandGroup): GroupKind {
  if (group.layout === "selector-first") return SELECTOR_FIRST;
  return PLAIN;
}

function groupShape(
  path: readonly string[],
  doc: Doc,
  kind: GroupKind,
  sight: Sight,
  own: readonly Method<Line>[] = [],
  children: readonly { name: string }[] = childrenOf(path),
): Shape<Line> {
  const methods = children.map((child) =>
    childMethod([...path, child.name], child.name, sight)
  );
  return new Shape<Line>([...methods, ...own], {
    ...kind.options(doc, sight),
    roster: sight.roster(path),
  });
}

/** Узел под группой: группа или лист (команда, поверхность). */
function childMethod(
  path: readonly string[],
  name: string,
  sight: Sight,
): Method<Line> {
  const group = findGroup(path);
  if (group !== undefined) {
    const doc = { purpose: group.summary, help: group.usage };
    return unary(
      name,
      doc,
      groupShape(path, doc, groupKind(group), sight),
      same,
    );
  }
  const doc = leafDoc(path);
  return unary(name, doc, dispatching(doc, sight, tailKind(path)), same);
}

/** Назначение и справка листа: команды или поверхности точки входа. */
function leafDoc(path: readonly string[]): Doc {
  const command = findCommand(path);
  if (command !== undefined) {
    return { purpose: command.summary, help: command.help };
  }
  const surface = findSurface(path);
  if (surface !== undefined) {
    return { purpose: surface.summary, help: surface.usage };
  }
  // Путь пришёл из `childrenOf`: он объявлен командой, группой или
  // поверхностью. Третьего не бывает, и молчать об этом нельзя — узел
  // без объявления дал бы пустую справку.
  throw new Error(`узел реестра без объявления: ${path.join(" ")}`);
}

/** Узел отдаёт дальше ту же строку. */
function same(line: Line): Line {
  return line;
}

/** Узел снимка дерева (`platform/back-rpc.md`, «Снимок дерева»). */
export interface TreeNode {
  readonly path: readonly string[];
  readonly summary: string;
  /** Собственные селекторы узла по алфавиту. */
  readonly selectors: readonly string[];
  /** Имя вида звена хвоста без скобок; хвоста нет — `null`. */
  readonly tail: string | null;
  /**
   * Флаги команды (`specs/complete.md`, «Снимок»): длинная форма и
   * короткая отдельной записью; `--help` не входит. У групп и узлов без
   * своих объявленных флагов — пусто.
   */
  readonly flags: readonly {
    readonly name: string;
    readonly summary: string;
  }[];
  /** Назначения собственных селекторов, у которых нет своего узла. */
  readonly summaries: Readonly<Record<string, string>>;
}

/** Флаги узла снимка: у команды — из её объявления, у прочих — нет. */
function flagsOf(path: readonly string[]): TreeNode["flags"] {
  const command = findCommand(path);
  if (command === undefined) return [];
  return commandFlags(command).flatMap((flag) => [
    { name: flag.name, summary: flag.summary },
    ...(flag.short === undefined
      ? []
      : [{ name: flag.short, summary: flag.summary }]),
  ]);
}

/** Узел снимка — со слов самого вида: его селекторы и его хвост. */
function nodeOf(
  path: readonly string[],
  summary: string,
  shape: Shape<Line>,
): TreeNode {
  const tail = shape.parsing().tail;
  const children = new Set(childrenOf(path).map((child) => child.name));
  return {
    path: [...path],
    summary,
    selectors: shape.selectors(),
    tail: tail === undefined ? null : tail.slice(1, -1),
    flags: flagsOf(path),
    summaries: Object.fromEntries(
      Object.entries(shape.purposes()).filter(([selector]) =>
        !children.has(selector)
      ),
    ),
  };
}

/** Узел и всё под ним, в глубину, дети по алфавиту. */
function nodesUnder(
  path: readonly string[],
  summary: string,
  shape: Shape<Line>,
): TreeNode[] {
  const children = childrenOf(path)
    .map((child) => child.name)
    .sort();
  return [
    nodeOf(path, summary, shape),
    ...children.flatMap((name) => {
      const childPath = [...path, name];
      const group = findGroup(childPath);
      if (group !== undefined) {
        const doc = { purpose: group.summary, help: group.usage };
        return nodesUnder(
          childPath,
          group.summary,
          groupShape(childPath, doc, groupKind(group), WHOLE),
        );
      }
      const doc = leafDoc(childPath);
      return [
        nodeOf(
          childPath,
          doc.purpose,
          dispatching(doc, WHOLE, tailKind(childPath)),
        ),
      ];
    }),
  ];
}

/** Узлы дерева команд для снимка: корень, группы, команды. */
export function registryNodes(): TreeNode[] {
  return nodesUnder([], ROOT_SUMMARY, rootShape(WHOLE));
}

/**
 * Путь правил узла снимка — тот, которым решается строка, дошедшая до
 * него: у узла с хвостом — со звеном `<args>`.
 */
export function ruleLinks(node: TreeNode): readonly string[] {
  return node.tail === null ? node.path : [...node.path, ARGS];
}

const ROOT_DOC: Doc = { purpose: ROOT_SUMMARY, help: ROOT_USAGE };

function rootShape(
  sight: Sight,
  own: readonly Method<Line>[] = [],
): Shape<Line> {
  return groupShape([], ROOT_DOC, PLAIN, sight, [...ruleMethods(), ...own]);
}

/** Имена поверхностей: у двери их нет, как и прочих сообщений корня. */
const SURFACES: ReadonlySet<string> = new Set(
  surfaces.map((surface) => surface.path[0]),
);

/**
 * Корень двери: только команды и группы реестра — сообщений корня
 * (правила, поверхности, методы двери строки) дверь не понимает.
 */
function doorShape(book: RuleBook): Shape<Line> {
  const children = childrenOf([]).filter((child) => !SURFACES.has(child.name));
  return groupShape([], ASK_DOC, PLAIN, new Seen(DOOR, book), [], children);
}

/**
 * Корень дерева реестра для строки `line`: команды и группы верхнего
 * уровня, сообщения о правилах подтверждения, вход в дверь `ask` и
 * методы `own`, которые даёт дверь строки. Списки справки обоих взглядов
 * — по решениям книги `book` на момент вопроса.
 *
 * @param line строка вызова с её исполнением
 * @param book правила строки
 */
export function registryRoot(
  line: Line,
  book: RuleBook,
  own: readonly Method<Line>[] = [],
): Call {
  const door = gate(ASK_WORD, ASK_DOC, doorShape(book), same);
  const shape = rootShape(new Seen(NORMAL, book), [door, ...own]);
  return origin(ROOT_DOC, shape, line);
}
