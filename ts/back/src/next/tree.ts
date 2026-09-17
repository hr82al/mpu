/**
 * Дерево объектов из реестра команд (`platform/registry-objects.md`,
 * «Дерево»). Запись реестра переводится в вид узла здесь, один раз; дальше
 * узел отвечает сам — детьми, хвостом и своим концом строки.
 */

import { ROOT_SUMMARY, ROOT_USAGE } from "../entrypoint/mod.ts";
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

/** Строка вызова: её исполняет нынешняя диспетчеризация целиком. */
export interface Line {
  dispatch(): Promise<number>;
}

/** Вид звена хвоста. */
const ARGS = "<args>";

/** Конец строки — исполнение строки диспетчеризацией. */
const DISPATCH: Ending<Line> = {
  finish: async (report, line) => report.exit(await line.dispatch()),
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
): Shape<Line> {
  const methods = childrenOf(path).map((child) =>
    childMethod([...path, child.name], child.name)
  );
  return new Shape<Line>(methods, kind.options(doc));
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

/**
 * Корень дерева реестра для строки `line`.
 *
 * @param line строка вызова с её исполнением
 */
export function registryRoot(line: Line): Call {
  const doc = { purpose: ROOT_SUMMARY, help: ROOT_USAGE };
  return origin(doc, groupShape([], doc, PLAIN), line);
}
