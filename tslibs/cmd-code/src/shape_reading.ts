/**
 * Чтение формы функций файла по синтаксису (`specs/code-shape.md`, «Что
 * меряется»). Только синтаксис отдельного файла: проект и типы не нужны.
 *
 * Обход идёт сверху вниз и несёт область: кто владеет глубиной и на
 * каком уровне стоит узел. Вид узла компилятора читается один раз, в
 * `scopeOf`: функция открывает свою область с нуля, обратный вызов
 * `describe` — ничью, оператор управления — уровень глубже у того же
 * владельца. Дальше обход вида узла не знает.
 */

import type TS from "typescript";
import { calleeHead } from "./callee.ts";
import {
  FlagCall,
  Measured,
  NO_OWNER,
  type Owner,
  Shape,
  Span,
} from "./shape.ts";

/** Безымянная функция без переменной и свойства (спека, «Ввод/вывод»). */
const ANONYMOUS = "(анонимная)";

/** Где стоит узел: владелец глубины и уровень вложенности. */
class Scope {
  constructor(
    private readonly owner: Owner,
    private readonly depth: number,
  ) {}

  /** Область внутри оператора управления: уровень глубже, владелец тот же. */
  control(): Scope {
    const depth = this.depth + 1;
    this.owner.reach(depth);
    return new Scope(this.owner, depth);
  }

  /** Область тела функции: её владелец, счёт с нуля. */
  static of(owner: Owner): Scope {
    return new Scope(owner, 0);
  }
}

/** Верхний уровень файла и тело `describe`: глубина ничья. */
const UNOWNED = Scope.of(NO_OWNER);

/** Функция с телом: то, что меряется. */
type Fn = (
  | TS.FunctionDeclaration
  | TS.MethodDeclaration
  | TS.ConstructorDeclaration
  | TS.AccessorDeclaration
  | TS.FunctionExpression
  | TS.ArrowFunction
) & { readonly body: TS.ConciseBody };

/** Учёт формы разобранного файла. */
export function readShape(ts: typeof TS, file: TS.SourceFile): Shape {
  const shape = new Shape();
  const visit = (node: TS.Node, outer: Scope): void => {
    const scope = scopeOf(ts, file, shape, node, outer);
    readFlags(ts, file, node, shape);
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  ts.forEachChild(file, (child) => visit(child, UNOWNED));
  return shape;
}

/**
 * Область детей узла — граница разбора: здесь и только здесь читается
 * вид узла. Обратный вызов `describe` проверяется раньше функции: он
 * функция по синтаксису, но контейнер по смыслу.
 */
function scopeOf(
  ts: typeof TS,
  file: TS.SourceFile,
  shape: Shape,
  node: TS.Node,
  outer: Scope,
): Scope {
  if (isDescribeCallback(ts, node)) return UNOWNED;
  if (isFunction(ts, node)) {
    const fn = measure(ts, file, node);
    shape.add(fn);
    return Scope.of(fn);
  }
  return isControl(ts, node) ? outer.control() : outer;
}

/** Операторы управления спеки; `else if` — уровень своего `if`. */
function isControl(ts: typeof TS, node: TS.Node): boolean {
  if (ts.isIfStatement(node)) {
    const parent = node.parent;
    return !(ts.isIfStatement(parent) && parent.elseStatement === node);
  }
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node)
  );
}

function isFunction(ts: typeof TS, node: TS.Node): node is Fn {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)) &&
    // Перегрузка, `declare` и абстрактный метод тела не имеют: мерить
    // в них нечего.
    node.body !== undefined
  );
}

/**
 * Функция — аргумент вызова `describe…(…)` или `describe.each(…)(…)`:
 * контейнер тестов, не логика (спека, «Что меряется»).
 */
function isDescribeCallback(ts: typeof TS, node: TS.Node): boolean {
  const call = node.parent;
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
    return false;
  }
  if (!ts.isCallExpression(call) || call.expression === node) return false;
  const callee = ts.isCallExpression(call.expression)
    ? call.expression.expression
    : call.expression;
  return calleeHead(ts, callee) === "describe";
}

/** Строка позиции, с единицы. */
function lineAt(file: TS.SourceFile, position: number): number {
  return file.getLineAndCharacterOfPosition(position).line + 1;
}

/** Строки узла от начала его текста до конца. */
function spanOf(file: TS.SourceFile, node: TS.Node): Span {
  return new Span(lineAt(file, node.getStart(file)), lineAt(file, node.end));
}

/**
 * Запись функции. Длина — от строки `{` тела до строки `}`; у стрелки с
 * телом-выражением — от `=>` до конца выражения.
 */
function measure(ts: typeof TS, file: TS.SourceFile, node: Fn): Measured {
  const opening =
    ts.isArrowFunction(node) && !ts.isBlock(node.body)
      ? node.equalsGreaterThanToken
      : node.body;
  const body = new Span(
    lineAt(file, opening.getStart(file)),
    lineAt(file, node.body.end),
  );
  return new Measured(nameOf(ts, file, node), spanOf(file, node), body);
}

/**
 * Имя функции: своё; у конструктора — `constructor`; у безымянной —
 * имя переменной или свойства, которому она присвоена; иначе
 * `(анонимная)`.
 */
function nameOf(ts: typeof TS, file: TS.SourceFile, node: Fn): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (!ts.isArrowFunction(node) && node.name !== undefined) {
    return node.name.getText(file);
  }
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node
  ) {
    return parent.name.getText(file);
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    ts.isPropertyAccessExpression(parent.left)
  ) {
    return parent.left.name.text;
  }
  return ANONYMOUS;
}

/**
 * Флаги вызова: у вызова с двумя аргументами и больше — каждый
 * позиционный литерал `true`/`false`. Матчер в цепочке от `expect(…)` —
 * утверждение о вызове, а не выбор поведения.
 */
function readFlags(
  ts: typeof TS,
  file: TS.SourceFile,
  node: TS.Node,
  shape: Shape,
): void {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
  const args = node.arguments ?? [];
  if (args.length < 2 || isMatcher(ts, node.expression)) return;
  // Цепочку, разнесённую по строкам, печатают одной строкой: вывод
  // построчный, и перевод строки разорвал бы запись на две.
  const call = node.expression.getText(file).replace(/\s*\n\s*/g, "");
  const span = spanOf(file, node);
  args.forEach((arg, index) => {
    if (
      arg.kind === ts.SyntaxKind.TrueKeyword ||
      arg.kind === ts.SyntaxKind.FalseKeyword
    ) {
      shape.addFlag(new FlagCall(call, index + 1, span));
    }
  });
}

/**
 * Вызываемое — метод в цепочке от `expect(…)` (`expect(x).not.toBe`,
 * `expect.soft(x).toEqual`): где-то ниже по цепочке стоит вызов, чьё
 * первое имя — `expect`.
 */
function isMatcher(ts: typeof TS, callee: TS.Expression): boolean {
  if (ts.isCallExpression(callee)) {
    return (
      calleeHead(ts, callee.expression) === "expect" ||
      isMatcher(ts, callee.expression)
    );
  }
  if (
    ts.isPropertyAccessExpression(callee) ||
    ts.isElementAccessExpression(callee) ||
    ts.isNonNullExpression(callee)
  ) {
    return isMatcher(ts, callee.expression);
  }
  return false;
}
