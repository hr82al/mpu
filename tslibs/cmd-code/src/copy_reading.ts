/**
 * Чтение копий файла по синтаксису (`specs/code-copies.md`, «Что
 * считается»): фрагменты, их лексемы и преобразования констант файла.
 *
 * Вид узла компилятора читается здесь и только здесь — в ответах «узел
 * — фрагмент?» и «вызов — преобразование?»; учёт (`copies.ts`) получает
 * готовые фрагменты и вида узла не знает. Обход один: преобразование —
 * тот же фрагмент со своим правилом отбора.
 */

import type TS from "typescript";
import { FileCopies, type Fragment, Span } from "./copies.ts";
import { singleFileProgram } from "./file_survey.ts";

/** Вызовы-контейнеры тестов и их формы через точку. */
const TEST_CALLS: readonly string[] = ["describe", "it", "test"];

/** Вызовы, которые преобразуют величину в другую форму. */
const CONVERSIONS: readonly string[] = [
  "Number",
  "String",
  "Boolean",
  "BigInt",
];

/** Учёт копий разобранного файла. */
export function readCopies(ts: typeof TS, file: TS.SourceFile): FileCopies {
  const copies = new FileCopies();
  const tokens = new Tokens(ts, file);
  const constants = new FileConstants(ts, file);
  const visit = (node: TS.Node): void => {
    const fragment = isFragment(ts, node);
    const conversion = isConversion(ts, node, constants);
    if (fragment || conversion) {
      const read = tokens.fragment(node);
      if (fragment) copies.addFragment(read);
      if (conversion) copies.addConversion(read);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return copies;
}

/**
 * Узел — фрагмент: вид из закрытого списка спеки и не контейнер теста.
 * Обёртки-операторы (`if`, `return`, оператор-выражение, блок) в список
 * не входят: их содержимое — выражения, и они фрагменты сами.
 */
function isFragment(ts: typeof TS, node: TS.Node): boolean {
  const kind =
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isVariableStatement(node);
  return kind && !isTestContainer(ts, node);
}

/**
 * Контейнер теста: вызов `describe`/`it`/`test` и их форм через точку и
 * через цепочку (`it.each(…)(…)`), и функция — аргумент такого вызова.
 */
function isTestContainer(ts: typeof TS, node: TS.Node): boolean {
  if (ts.isCallExpression(node)) return isTestCall(ts, node);
  const call = node.parent;
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isCallExpression(call) &&
    call.arguments.some((argument) => argument === node) &&
    isTestCall(ts, call)
  );
}

/**
 * Вызов теста: корень цепочки вызываемого — имя `describe`/`it`/`test`.
 * У `it.each(t)(…)` вызываемое — снова вызов, у `describe.skip` —
 * свойство; корень не имя (`/x/.test(…)`, `foo().it(…)`) — не тест.
 */
function isTestCall(ts: typeof TS, call: TS.CallExpression): boolean {
  let root: TS.Expression = call.expression;
  while (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root)) {
    root = root.expression;
  }
  return ts.isIdentifier(root) && TEST_CALLS.includes(root.text);
}

/**
 * Преобразование: `Number`/`String`/`Boolean`/`BigInt` ровно с одним
 * аргументом-именем, и имя — константа файла. Литерал, выражение,
 * свойство и параметр — нет.
 */
function isConversion(
  ts: typeof TS,
  node: TS.Node,
  constants: FileConstants,
): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) {
    return false;
  }
  const args = node.arguments;
  return (
    CONVERSIONS.includes(node.expression.text) &&
    args.length === 1 &&
    ts.isIdentifier(args[0]) &&
    constants.has(args[0])
  );
}

/**
 * Константы файла — имена, объявленные на его верхнем уровне
 * (`const`/`let`/`var`, имя из `import`). Имя разрешает checker
 * программы из одного файла: он знает все области видимости — блок,
 * параметр, `catch`, подъём `var`, — и перекрытое имя указывает на своё
 * объявление, а не на константу.
 */
class FileConstants {
  readonly #checker: TS.TypeChecker;

  constructor(
    private readonly ts: typeof TS,
    private readonly file: TS.SourceFile,
  ) {
    this.#checker = singleFileProgram(ts, file).getTypeChecker();
  }

  /** Указывает ли имя на константу файла; неразрешённое — нет. */
  has(name: TS.Identifier): boolean {
    const symbol = this.#checker.getSymbolAtLocation(name);
    // Граница API компилятора: имени без объявления в файле (глобал,
    // опечатка) символа нет — это ответ «не константа».
    const declarations = symbol?.declarations ?? [];
    return declarations.some((declaration) => this.#topLevel(declaration));
  }

  #topLevel(declaration: TS.Declaration): boolean {
    const { ts, file } = this;
    if (
      ts.isImportClause(declaration) ||
      ts.isImportSpecifier(declaration) ||
      ts.isNamespaceImport(declaration)
    ) {
      return true;
    }
    if (ts.isImportEqualsDeclaration(declaration)) {
      return declaration.parent === file;
    }
    let node: TS.Node = declaration;
    while (
      ts.isBindingElement(node) ||
      ts.isObjectBindingPattern(node) ||
      ts.isArrayBindingPattern(node)
    ) {
      node = node.parent;
    }
    return (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent) &&
      node.parent.parent.parent === file
    );
  }
}

/**
 * Лексемы файла — листья дерева в том порядке, в каком их отдаёт
 * сканер; читаются один раз. Пробелы, переводы строк и комментарии
 * (JSDoc в том числе) лексемами не являются; текст JSX — лексема со
 * сжатыми пробелами, а одни пробелы в JSX — не лексема.
 */
class Tokens {
  readonly #starts: number[] = [];
  readonly #ends: number[] = [];
  readonly #ids: number[] = [];
  readonly #known = new Map<string, number>();

  constructor(
    private readonly ts: typeof TS,
    private readonly file: TS.SourceFile,
  ) {
    this.#read(file);
  }

  /** Фрагмент узла: лексемы ключом, их число, текст и место. */
  fragment(node: TS.Node): Fragment {
    const { file } = this;
    const start = node.getStart(file);
    const end = node.getEnd();
    const first = this.#firstFrom(start);
    let last = first;
    while (last < this.#ids.length && this.#ends[last] <= end) last += 1;
    const lineOf = (at: number) =>
      file.getLineAndCharacterOfPosition(at).line + 1;
    return {
      key: this.#ids.slice(first, last).join(","),
      size: last - first,
      text: node.getText(file),
      span: new Span(start, end, lineOf(start), lineOf(end)),
    };
  }

  /** Номер первой лексемы, начинающейся не раньше `start`. */
  #firstFrom(start: number): number {
    let low = 0;
    let high = this.#starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.#starts[middle] < start) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  #read(node: TS.Node): void {
    const { ts, file } = this;
    if (isJsDoc(ts, node)) return;
    if (!ts.isTokenKind(node.kind)) {
      for (const child of node.getChildren(file)) this.#read(child);
      return;
    }
    const text = lexeme(ts, node, file);
    if (text === "") return;
    this.#starts.push(node.getStart(file));
    this.#ends.push(node.getEnd());
    this.#ids.push(this.#id(text));
  }

  #id(text: string): number {
    const known = this.#known.get(text);
    if (known !== undefined) return known;
    const id = this.#known.size;
    this.#known.set(text, id);
    return id;
  }
}

/**
 * Текст лексемы; пустой — не лексема (конец файла, пробелы в JSX). Текст
 * JSX сжат: перенос строки в нём — разметка, а не данные.
 */
function lexeme(ts: typeof TS, node: TS.Node, file: TS.SourceFile): string {
  if (ts.isJsxText(node)) return node.text.replace(/\s+/g, " ").trim();
  return node.getText(file);
}

/** Комментарий JSDoc: дерево держит его узлами, но он не лексема. */
function isJsDoc(ts: typeof TS, node: TS.Node): boolean {
  return (
    node.kind >= ts.SyntaxKind.FirstJSDocNode &&
    node.kind <= ts.SyntaxKind.LastJSDocNode
  );
}
