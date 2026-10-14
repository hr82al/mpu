/**
 * Чтение литералов файла по синтаксису (`specs/code-literals.md`, «Что
 * считается»). Только синтаксис отдельного файла: проект и типы не
 * нужны, поэтому и гарантии в шапке ответа нет.
 *
 * Обход идёт сверху вниз и несёт прочтение места: литерал попадает в
 * учёт тем способом, который назначило место, а место назначают правила
 * исключения. Правило, не подходящее к узлу, отвечает унаследованным
 * прочтением — поэтому ветки «применимо или нет» у обхода нет.
 */

import type TS from "typescript";
import { Tally } from "./literals.ts";

/** Как литерал этого места попадает в учёт. */
interface Reading {
  string(tally: Tally, text: string, line: number): void;
  number(tally: Tally, value: number, line: number): void;
}

/** Данные: строка и даты внутри неё, число. */
const DATA: Reading = {
  string: (tally, text, line) => tally.addString(text, line),
  number: (tally, value, line) => tally.addNumber(value, line),
};

/**
 * Адрес экрана: сам он не данные, но подпись дня в поиске — вторая форма
 * той же даты, поэтому даты внутри строк остаются (спека, правило 2).
 */
const SCREEN: Reading = {
  string: (tally, text, line) => tally.addDatesIn(text, line),
  number: () => {},
};

/** Название, модуль, имя, тип: в учёт не идёт ничего. */
const IGNORED: Reading = {
  string: () => {},
  number: () => {},
};

/** Правило исключения: какое прочтение получает узел. */
interface Rule {
  readingOf(node: TS.Node, inherited: Reading): Reading;
}

/** Вызовы, первый аргумент которых — название теста. */
const TEST_CALLS: readonly string[] = ["describe", "it", "test"];

/** Вызовы, первый аргумент которых — спецификатор модуля. */
const MODULE_CALLS: readonly string[] = [
  "require",
  "vi.mock",
  "vi.importActual",
  "jest.mock",
];

/** Поиски экрана (спека, правило 2): у объекта, `screen`, `within(…)`. */
const SCREEN_SEARCH =
  /^(get|getAll|query|queryAll|find|findAll)By(TestId|Role|Text|LabelText|PlaceholderText|AltText|Title|DisplayValue)$/;

/**
 * Закрытый список правил спеки. Тривиальные значения (правило 5) — не
 * правило места, а свойство значения: их отсекает учёт.
 */
function exclusionRules(ts: typeof TS): readonly Rule[] {
  return [testNames(ts), screenSearches(ts), moduleSpecifiers(ts), names(ts)];
}

/**
 * Правило 1: первый аргумент `describe`/`it`/`test` и их форм через
 * точку; у `it.each(…)` первый аргумент — таблица данных, а название —
 * первый аргумент второго вызова. Тело теста — второй аргумент, и его
 * литералы остаются данными.
 */
function testNames(ts: typeof TS): Rule {
  const testCall = (name: string): boolean =>
    TEST_CALLS.includes(name.split(".")[0]);
  const named = (callee: TS.Expression): boolean => {
    if (ts.isCallExpression(callee)) {
      const each = calleeName(ts, callee.expression);
      return testCall(each) && each.endsWith(".each");
    }
    const name = calleeName(ts, callee);
    return testCall(name) && !name.endsWith(".each");
  };
  return {
    readingOf: (node, inherited) =>
      argumentIndex(ts, node, named) === 0 ? IGNORED : inherited,
  };
}

/** Правило 2: все аргументы поиска экрана, включая объект опций. */
function screenSearches(ts: typeof TS): Rule {
  const search = (callee: TS.Expression): boolean =>
    SCREEN_SEARCH.test(lastName(ts, callee));
  return {
    readingOf: (node, inherited) =>
      argumentIndex(ts, node, search) >= 0 ? SCREEN : inherited,
  };
}

/** Правило 3: спецификаторы модулей. */
function moduleSpecifiers(ts: typeof TS): Rule {
  const loads = (callee: TS.Expression): boolean =>
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    MODULE_CALLS.includes(calleeName(ts, callee));
  const specifier = (node: TS.Node): boolean => {
    const parent = node.parent;
    return (
      ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
        parent.moduleSpecifier === node) ||
      ts.isExternalModuleReference(parent)
    );
  };
  return {
    readingOf: (node, inherited) =>
      specifier(node) || argumentIndex(ts, node, loads) === 0
        ? IGNORED
        : inherited,
  };
}

/** Правило 4: имя свойства в объекте и в типе, позиция типа. */
function names(ts: typeof TS): Rule {
  const nameOf = (node: TS.Node): boolean => {
    const parent = node.parent;
    if (ts.isBindingElement(parent)) return parent.propertyName === node;
    return (
      (ts.isPropertyAssignment(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isEnumMember(parent)) &&
      parent.name === node
    );
  };
  return {
    readingOf: (node, inherited) =>
      ts.isTypeNode(node) || nameOf(node) ? IGNORED : inherited,
  };
}

/**
 * Номер аргумента, которым узел стоит в вызове, чей вызываемый узнаёт
 * `callee`; `-1` — не аргумент такого вызова (как у `findIndex`).
 */
function argumentIndex(
  ts: typeof TS,
  node: TS.Node,
  callee: (expression: TS.Expression) => boolean,
): number {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !callee(call.expression)) return -1;
  // `findIndex`, а не `indexOf`: тот ждёт `Expression`, а узел здесь —
  // любой `Node`, и приведение `as` сказало бы о нём больше, чем известно.
  return call.arguments.findIndex((argument) => argument === node);
}

/** Последнее имя вызываемого: `getByRole` у `screen.getByRole`. */
function lastName(ts: typeof TS, expression: TS.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}

/**
 * Имя вызываемого через точку (`vi.mock`, `screen.getByRole`); у
 * `within(…).getByText` — от вызова дальше. Прочие формы — пусто.
 */
function calleeName(ts: typeof TS, expression: TS.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const head = calleeName(ts, expression.expression);
    return head === ""
      ? expression.name.text
      : `${head}.${expression.name.text}`;
  }
  return "";
}

/** Исход разбора файла: учёт литералов или причина, почему его нет. */
export interface FileReading {
  /** Отдаёт себя ответу: разделом файла либо строкой «не разрешено». */
  report(answer: FileAnswer): void;
}

/** Куда файл отдаёт свой исход. */
export interface FileAnswer {
  parsed(path: string, tally: Tally): void;
  unparsed(path: string, reason: string): void;
}

/**
 * Разбирает текст файла. Синтаксическая ошибка — не отказ всего ответа,
 * а строка «не разрешено»: остальные адреса отвечают.
 */
export function readLiterals(
  ts: typeof TS,
  path: string,
  text: string,
): FileReading {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const errors = syntaxErrors(ts, file);
  if (errors.length > 0) {
    const reason = describeError(ts, file, errors[0]);
    return { report: (answer) => answer.unparsed(path, reason) };
  }
  const tally = new Tally();
  const rules = exclusionRules(ts);
  const visit = (node: TS.Node, inherited: Reading): void => {
    const reading = rules.reduce(
      (current, rule) => rule.readingOf(node, current),
      inherited,
    );
    if (readLiteral(ts, file, node, reading, tally)) return;
    ts.forEachChild(node, (child) => visit(child, reading));
  };
  // С детей, а не с самого файла: у корня нет родителя, а правила
  // спрашивают о месте узла в родителе.
  ts.forEachChild(file, (child) => visit(child, DATA));
  return { report: (answer) => answer.parsed(path, tally) };
}

/**
 * Литерал данных на границе разбора: вид узла компилятора читается
 * здесь один раз, дальше — только прочтение места. Минус перед числом —
 * часть значения. Ответ — был ли узел литералом.
 */
function readLiteral(
  ts: typeof TS,
  file: TS.SourceFile,
  node: TS.Node,
  reading: Reading,
  tally: Tally,
): boolean {
  const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    reading.string(tally, node.text, line);
    return true;
  }
  if (ts.isNumericLiteral(node)) {
    reading.number(tally, Number(node.text), line);
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    reading.number(tally, -Number(node.operand.text), line);
    return true;
  }
  return false;
}

/**
 * Синтаксические ошибки файла. Публичный путь к ним — программа из
 * одного файла: собственный перечень ошибок разбора у `SourceFile`
 * закрыт. Ни библиотек, ни импортов программа не грузит.
 */
function syntaxErrors(
  ts: typeof TS,
  file: TS.SourceFile,
): readonly TS.DiagnosticWithLocation[] {
  // `types: []` — иначе программа обходит `node_modules/@types` на
  // каждый файл, хотя типы разбору синтаксиса не нужны.
  const options: TS.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file.fileName ? file : undefined);
  const program = ts.createProgram([file.fileName], options, host);
  return program.getSyntacticDiagnostics(file);
}

/** Причина разбора: строка первой ошибки и текст компилятора. */
function describeError(
  ts: typeof TS,
  file: TS.SourceFile,
  error: TS.DiagnosticWithLocation,
): string {
  const line = file.getLineAndCharacterOfPosition(error.start).line + 1;
  return `строка ${line}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`;
}
