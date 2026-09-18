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
  type Method,
  origin,
  Shape,
  type ShapeOptions,
  tail,
  unary,
} from "../objects/mod.ts";
import {
  childrenOf,
  type CommandGroup,
  findCommand,
  findGroup,
  findSurface,
} from "../registry/mod.ts";
import type { Line } from "./line.ts";
import { ruleMethods } from "./rules.ts";

/** Вид звена хвоста. */
const ARGS = "<args>";

/** Конец строки — исполнение строки диспетчеризацией. */
const DISPATCH: Ending<Line> = {
  finish: (report, line) => line.dispatch(report),
};

/** Вид, который забирает хвост и в конце строки исполняет её. */
function dispatching(doc: Doc): Shape<Line> {
  const shape: Shape<Line> = new Shape<Line>([], {
    fallback: tail(ARGS, doc, () => shape),
    ending: DISPATCH,
  });
  return shape;
}

/** Вид узла группы: что она делает с чужим словом и с концом строки. */
interface GroupKind {
  options(doc: Doc): ShapeOptions<Line>;
}

/** Только дети; конец строки — справка. */
const PLAIN: GroupKind = { options: () => ({}) };

/** Группа с собственным исполнением без подкоманды (`mcp`). */
const BARE: GroupKind = {
  options: (doc) => {
    const after = dispatching(doc);
    return { fallback: tail(ARGS, doc, () => after), ending: DISPATCH };
  },
};

/** Группа с селектором перед подкомандой: чужое слово начинает хвост. */
const SELECTOR_FIRST: GroupKind = {
  options: (doc) => {
    const after = dispatching(doc);
    return { fallback: tail(ARGS, doc, () => after) };
  },
};

function groupKind(group: CommandGroup): GroupKind {
  if (group.bare !== undefined) return BARE;
  if (group.layout === "selector-first") return SELECTOR_FIRST;
  return PLAIN;
}

function groupShape(
  path: readonly string[],
  doc: Doc,
  kind: GroupKind,
  own: readonly Method<Line>[] = [],
): Shape<Line> {
  const methods = childrenOf(path).map((child) =>
    childMethod([...path, child.name], child.name)
  );
  return new Shape<Line>([...methods, ...own], kind.options(doc));
}

/** Узел под группой: группа или лист (команда, поверхность). */
function childMethod(path: readonly string[], name: string): Method<Line> {
  const group = findGroup(path);
  if (group !== undefined) {
    const doc = { purpose: group.summary, help: group.usage };
    return unary(name, doc, groupShape(path, doc, groupKind(group)), same);
  }
  const doc = leafDoc(path);
  return unary(name, doc, dispatching(doc), same);
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
          groupShape(childPath, doc, groupKind(group)),
        );
      }
      const doc = leafDoc(childPath);
      return [nodeOf(childPath, doc.purpose, dispatching(doc))];
    }),
  ];
}

/** Узлы дерева `mpu-next` для снимка: корень, группы, команды. */
export function registryNodes(): TreeNode[] {
  return nodesUnder([], ROOT_SUMMARY, rootShape());
}

function rootShape(): Shape<Line> {
  const doc = { purpose: ROOT_SUMMARY, help: ROOT_USAGE };
  return groupShape([], doc, PLAIN, ruleMethods());
}

/**
 * Корень дерева реестра для строки `line`: команды и группы верхнего
 * уровня и сообщения о правилах подтверждения.
 *
 * @param line строка вызова с её исполнением
 */
export function registryRoot(line: Line): Call {
  const doc = { purpose: ROOT_SUMMARY, help: ROOT_USAGE };
  return origin(doc, rootShape(), line);
}
