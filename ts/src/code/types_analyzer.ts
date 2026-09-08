/**
 * Анализатор по типам (`platform/code-analyzer.md`): гарантия полная —
 * перечень потребителей равен ответу оракула «переименовать символ и
 * посчитать сломавшееся».
 *
 * Полнота держится на том, что вопрос задаётся не тексту, а тому же
 * разбору, который делает сборку: символ сравнивается с символом, а не
 * имя с именем, поэтому переименование при импорте, реэкспорт входа и
 * алиас `paths` попадают в перечень наравне с относительным импортом.
 */

import type TS from "typescript";
import type {
  Analyzer,
  Declaration,
  Place,
  Scope,
  Target,
  Unresolved,
} from "./analyzer.ts";
import { byPathAndLine } from "./analyzer.ts";
import { bodiesIn } from "./body.ts";
import type { MarkSource } from "./mark.ts";
import { dirOf } from "./project.ts";

/** Причины, по которым ссылку разрешить не удалось. */
const NOT_FOUND = "модуль не найден";
const NOT_LITERAL = "спецификатор не литерал";

/** Что нужно анализатору сверх самой программы. */
export interface TypeAnalyzerDeps {
  readonly ts: typeof TS;
  readonly program: TS.Program;
  /** Путь конфигурации проекта: рядом с ней лежит манифест пакета. */
  readonly projectPath: string;
  readonly repoRoot: string;
  readonly mark: MarkSource;
}

/** Анализатор по типам поверх готовой программы проекта. */
export function createTypeAnalyzer(deps: TypeAnalyzerDeps): Analyzer {
  const { ts, program, repoRoot } = deps;
  const checker = program.getTypeChecker();
  const entry = entryFile(ts, program, deps.projectPath);
  const files = program.getSourceFiles()
    .filter((file) => !file.isDeclarationFile && inRepo(file.fileName));

  function inRepo(fileName: string): boolean {
    return fileName.startsWith(`${repoRoot}/`) &&
      !fileName.includes("/node_modules/");
  }

  function rel(fileName: string): string {
    return fileName.slice(repoRoot.length + 1);
  }

  function fileOf(path: string): TS.SourceFile | undefined {
    return program.getSourceFile(`${repoRoot}/${path}`);
  }

  return {
    guarantee: "types",
    mark: deps.mark,
    hasFile: (path) => fileOf(path) !== undefined,
    files: () => files.map((file) => rel(file.fileName)).sort(),
    declarationsOf: (path) => {
      const file = fileOf(path);
      return {
        kind: "known",
        declarations: file === undefined
          ? []
          : declarationsIn(ts, checker, file, entry),
      };
    },
    declarationsRefusal: () => null,
    bodiesOf: () => ({
      kind: "known",
      bodies: files.flatMap((file) =>
        bodiesIn(ts, checker, file, rel(file.fileName))
      ),
    }),
    consumersOf: (target) => placesFor(ts, checker, files, fileOf, rel, target),
    unresolvedOf: () => unresolvedIn(ts, checker, files, rel),
  };
}

/**
 * Вход проекта: файл поля входа пакета, иначе `index.ts` в общем корне
 * исходников. Ни того ни другого — входа у проекта нет
 * (`platform/code-analyzer.md`, «Область видимости»).
 */
function entryFile(
  ts: typeof TS,
  program: TS.Program,
  projectPath: string,
): TS.SourceFile | undefined {
  const roots = program.getRootFileNames();
  if (roots.length === 0) return undefined;
  const declared = declaredEntry(ts, program, dirOf(projectPath));
  if (declared !== undefined) return declared;
  return program.getSourceFile(`${commonDir(roots)}/index.ts`);
}

/**
 * Общий корень исходников: самый длинный общий каталог их путей. Своим
 * счётом, а не `getCommonSourceDirectory`: тот в публичных типах
 * компилятора не объявлен.
 */
function commonDir(paths: readonly string[]): string {
  const split = paths.map((path) => path.split("/").slice(0, -1));
  const first = split[0];
  let depth = first.length;
  for (const parts of split.slice(1)) {
    depth = Math.min(depth, parts.length);
    while (
      depth > 0 &&
      parts.slice(0, depth).join("/") !== first.slice(0, depth).join("/")
    ) {
      depth -= 1;
    }
  }
  return first.slice(0, depth).join("/");
}

/**
 * Файл поля входа пакета рядом с конфигурацией проекта. Поле
 * засчитывается, ТОЛЬКО если ведёт в файл программы: на живом пакете
 * `main` указывает на `dist/index.js`, артефакта в программе нет, и
 * вход по нему находиться не должен (замер 2026-09-08 на `ozon`).
 */
function declaredEntry(
  ts: typeof TS,
  program: TS.Program,
  dir: string,
): TS.SourceFile | undefined {
  for (const name of ["package.json", "deno.json", "deno.jsonc"]) {
    for (const path of entryFields(ts, `${dir}/${name}`)) {
      const file = program.getSourceFile(`${dir}/${path.replace(/^\.\//, "")}`);
      if (file !== undefined) return file;
    }
  }
  return undefined;
}

/** Кандидаты входа из манифеста по порядку `types`, `exports`, `main`. */
function entryFields(ts: typeof TS, path: string): readonly string[] {
  const text = ts.sys.readFile(path);
  if (text === undefined) return [];
  const manifest = ts.parseConfigFileTextToJson(path, text).config;
  if (typeof manifest !== "object" || manifest === null) return [];
  const fields = manifest as Record<string, unknown>;
  return [fields.types, pickExport(fields.exports), fields.main]
    .filter((value): value is string => typeof value === "string");
}

/** Строковый вход из поля `exports` в любой из его форм. */
function pickExport(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const root = (value as Record<string, unknown>)["."];
  if (typeof root === "string") return root;
  if (typeof root !== "object" || root === null) return undefined;
  const conditions = root as Record<string, unknown>;
  return [conditions.import, conditions.default]
    .find((value): value is string => typeof value === "string");
}

/** Объявления верхнего уровня файла по возрастанию строки. */
function declarationsIn(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  entry: TS.SourceFile | undefined,
): readonly Declaration[] {
  const found: Declaration[] = [];
  for (const statement of file.statements) {
    for (const node of namedNodes(ts, statement)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol === undefined) continue;
      const type = checker.getTypeOfSymbolAtLocation(symbol, node.name);
      const call = type.getCallSignatures();
      found.push({
        name: symbol.getName(),
        signature: call.length > 0
          ? checker.signatureToString(call[0])
          : checker.typeToString(type),
        returnType: call.length > 0
          ? checker.typeToString(call[0].getReturnType())
          : null,
        line: lineOf(file, node.getStart(file)),
        scope: scopeOf(ts, checker, symbol, file, entry),
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** Узлы утверждения, вводящие имя: объявление или его переменные. */
function namedNodes(
  ts: typeof TS,
  statement: TS.Statement,
): readonly {
  readonly name: TS.Node;
  readonly getStart: (f: TS.SourceFile) => number;
}[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .filter((declaration) => ts.isIdentifier(declaration.name))
      .map((declaration) => ({
        name: declaration.name,
        getStart: (f: TS.SourceFile) => declaration.getStart(f),
      }));
  }
  // Приведение вместо перечисления десятка `ts.is*`: поле `name` есть у
  // всех объявлений верхнего уровня, вводящих имя, и объявлено оно в
  // каждом их типе — но общего надтипа с ним компилятор не даёт.
  // Значение проверяется следующей строкой, а не берётся на веру.
  const named = statement as TS.Statement & { readonly name?: TS.Node };
  if (named.name === undefined || !ts.isIdentifier(named.name)) return [];
  return [{
    name: named.name,
    getStart: (f: TS.SourceFile) => statement.getStart(f),
  }];
}

/** Область видимости символа: одно значение из четырёх. */
function scopeOf(
  ts: typeof TS,
  checker: TS.TypeChecker,
  symbol: TS.Symbol,
  file: TS.SourceFile,
  entry: TS.SourceFile | undefined,
): Scope {
  if (!isExportedFrom(ts, checker, symbol, file)) return "private";
  if (entry === undefined) return "no-entry";
  return isExportedFrom(ts, checker, symbol, entry) ? "entry" : "module-only";
}

/** Виден ли символ среди экспортов модуля — сам либо через алиас. */
function isExportedFrom(
  ts: typeof TS,
  checker: TS.TypeChecker,
  symbol: TS.Symbol,
  file: TS.SourceFile,
): boolean {
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (moduleSymbol === undefined) return false;
  return checker.getExportsOfModule(moduleSymbol)
    .some((exported) => resolveAlias(ts, checker, exported) === symbol);
}

/** Символ, на который указывает алиас; не алиас — он сам. */
function resolveAlias(
  ts: typeof TS,
  checker: TS.TypeChecker,
  symbol: TS.Symbol,
): TS.Symbol {
  // Флаг проверяется до вызова: `getAliasedSymbol` на не-алиасе
  // бросает, а не отвечает исходным символом.
  const isAlias = (symbol.flags & ts.SymbolFlags.Alias) !== 0;
  return isAlias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Строка позиции, считая с единицы. */
function lineOf(file: TS.SourceFile, pos: number): number {
  return file.getLineAndCharacterOfPosition(pos).line + 1;
}

/**
 * Файлы-потребители цели. Единица — файл: обращения внутри файла не
 * печатаются и в счёт не идут, потому что на живом коде один файл даёт
 * десятки обращений и число «мест» не сходится ни с чем.
 */
function placesFor(
  ts: typeof TS,
  checker: TS.TypeChecker,
  files: readonly TS.SourceFile[],
  fileOf: (path: string) => TS.SourceFile | undefined,
  rel: (fileName: string) => string,
  target: Target,
): readonly Place[] {
  const targetFile = fileOf(target.path);
  if (targetFile === undefined) return [];
  const others = files.filter((file) => file !== targetFile);
  if (target.kind === "module") {
    return others
      .flatMap((file) =>
        at(rel, file, readerLine(ts, checker, file, targetFile))
      )
      .sort(byPathAndLine);
  }
  const symbol = symbolAt(ts, checker, targetFile, target.line);
  if (symbol === undefined) return [];
  return others
    .flatMap((file) => at(rel, file, receivingLine(ts, checker, file, symbol)))
    .sort(byPathAndLine);
}

/** Место из строки: её нет — файл потребителем не является. */
function at(
  rel: (fileName: string) => string,
  file: TS.SourceFile,
  line: number | undefined,
): readonly Place[] {
  return line === undefined ? [] : [{ path: rel(file.fileName), line }];
}

/**
 * Строка, которой файл читает модуль; не читает — `undefined`. Формы
 * получения перебираются те же, что и у символа: читателем модуля файл
 * делает и динамический `import()`.
 */
function readerLine(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  module: TS.SourceFile,
): number | undefined {
  let line: number | undefined;
  const visit = (node: TS.Node): void => {
    const specifier = moduleSpecifierOf(ts, node);
    if (
      specifier !== undefined &&
      resolvedFile(ts, checker, specifier) === module
    ) {
      const start = lineOf(file, statementOf(ts, node).getStart(file));
      line = line === undefined ? start : Math.min(line, start);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return line;
}

/** Символ объявления, начинающегося в строке `line`. */
function symbolAt(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  line: number,
): TS.Symbol | undefined {
  for (const statement of file.statements) {
    for (const node of namedNodes(ts, statement)) {
      if (lineOf(file, node.getStart(file)) !== line) continue;
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol !== undefined) return symbol;
    }
  }
  return undefined;
}

/**
 * Берёт ли файл символ, и если берёт — строкой чего именно
 * (`platform/code-analyzer.md`, «Форма получения символа значения не
 * имеет»).
 *
 * Признак потребления — не перечень форм импорта, а само обращение к
 * символу: потребителем считается файл, который ломает переименование.
 * Перечисление форм теряло бы динамический `import()` и
 * `import x = require()` молча — под шапкой «ответ полон».
 *
 * Обратное следует отсюда же: голый `import "./a.ts"` и
 * `export * from "./a.ts"` символа не берут — обращений к нему в таком
 * файле нет, — и в перечень не попадают.
 */
function receivingLine(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  symbol: TS.Symbol,
): number | undefined {
  const uses = usePositions(ts, checker, file, symbol);
  if (uses.length === 0) return undefined;
  // Печатается строка, которой символ приходит в файл, а не первое
  // обращение: один файл берёт символ один раз, а зовёт сколько угодно.
  const entry = entryLine(ts, checker, file, symbol);
  return entry ?? lineOf(file, uses[0]);
}

/**
 * Позиции обращений к символу. Кандидаты отбираются по имени: оракул —
 * переименование, а переименование меняет ровно те места, где старое
 * имя написано, включая `addDays` в `import { addDays as plus }`.
 */
function usePositions(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  symbol: TS.Symbol,
): readonly number[] {
  const name = symbol.getName();
  const found: number[] = [];
  const visit = (node: TS.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const local = checker.getSymbolAtLocation(node);
      if (local !== undefined && resolveAlias(ts, checker, local) === symbol) {
        found.push(node.getStart(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Строка утверждения, которым модуль символа приходит в файл: импорт,
 * реэкспорт, динамический `import()` либо `import … = require()`.
 * Модуля нет — `undefined`, и строкой станет само обращение.
 */
function entryLine(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  symbol: TS.Symbol,
): number | undefined {
  let line: number | undefined;
  const visit = (node: TS.Node): void => {
    const specifier = moduleSpecifierOf(ts, node);
    if (
      specifier !== undefined && bringsNames(ts, node) &&
      exportsSymbol(ts, checker, specifier, symbol)
    ) {
      const start = lineOf(file, statementOf(ts, node).getStart(file));
      line = line === undefined ? start : Math.min(line, start);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return line;
}

/**
 * Приносит ли утверждение имена. Голый `import "./a.ts"` и
 * `export * from "./a.ts"` не приносят, и печатать их строкой как ту,
 * «которой файл символ получает», значило бы указать не туда.
 */
function bringsNames(ts: typeof TS, node: TS.Node): boolean {
  if (ts.isImportDeclaration(node)) return node.importClause !== undefined;
  if (ts.isExportDeclaration(node)) return node.exportClause !== undefined;
  return true;
}

/** Экспортирует ли модуль литерала искомый символ. */
function exportsSymbol(
  ts: typeof TS,
  checker: TS.TypeChecker,
  specifier: TS.Expression,
  symbol: TS.Symbol,
): boolean {
  const module = checker.getSymbolAtLocation(specifier);
  if (module === undefined) return false;
  return checker.getExportsOfModule(module)
    .some((exported) => resolveAlias(ts, checker, exported) === symbol);
}

/**
 * Утверждение, которому принадлежит узел: строка печатается по нему.
 * У статического импорта это он сам, у динамического — объемлющее
 * утверждение (`const days = await import(…)`).
 */
function statementOf(ts: typeof TS, node: TS.Node): TS.Node {
  let current: TS.Node = node;
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) {
    if (ts.isStatement(current)) return current;
    current = current.parent;
  }
  return current;
}

/**
 * Литерал модуля у любой формы получения: статического импорта,
 * реэкспорта, динамического `import()` и `import … = require()`.
 * Узел другой формы — `undefined`.
 */
function moduleSpecifierOf(
  ts: typeof TS,
  node: TS.Node,
): TS.Expression | undefined {
  if (ts.isImportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node)) {
    return ts.isExternalModuleReference(node.moduleReference)
      ? node.moduleReference.expression
      : undefined;
  }
  if (!ts.isCallExpression(node)) return undefined;
  // `import('./days')`: узел вызова, чьё «имя» — ключевое слово import.
  if (node.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  return node.arguments.at(0);
}

/**
 * Динамический импорт с невычислимым спецификатором: `import(name)`.
 * Разрешить его нельзя, и молчать о нём тоже — иначе ссылка выпадает
 * под шапкой «ответ полон».
 */
function isComputedImport(ts: typeof TS, specifier: TS.Expression): boolean {
  return !ts.isStringLiteralLike(specifier);
}

/** Файл, на который указывает литерал модуля; не разрешился — `undefined`. */
function resolvedFile(
  ts: typeof TS,
  checker: TS.TypeChecker,
  specifier: TS.Expression,
): TS.SourceFile | undefined {
  const module = checker.getSymbolAtLocation(specifier);
  const declaration = module?.valueDeclaration ?? module?.declarations?.[0];
  if (declaration === undefined || !ts.isSourceFile(declaration)) {
    return undefined;
  }
  return declaration;
}

/**
 * Ссылки репозитория, которые разобрать не удалось. Раздел печатается
 * всегда: инструмент, тихо выбрасывающий неразобранное, выдаёт
 * уверенный неверный ответ.
 */
function unresolvedIn(
  ts: typeof TS,
  checker: TS.TypeChecker,
  files: readonly TS.SourceFile[],
  rel: (fileName: string) => string,
): readonly Unresolved[] {
  const found: Unresolved[] = [];
  for (const file of files) {
    const visit = (node: TS.Node): void => {
      const specifier = moduleSpecifierOf(ts, node);
      // Форма проверяется раньше символа: у спецификатора-переменной
      // символ есть — свой собственный, — и проверка «символа нет»
      // такую ссылку пропускала бы молча (замер 2026-09-08).
      if (
        specifier !== undefined &&
        (isComputedImport(ts, specifier) ||
          checker.getSymbolAtLocation(specifier) === undefined)
      ) {
        found.push({
          path: rel(file.fileName),
          line: lineOf(file, statementOf(ts, node).getStart(file)),
          specifier: ts.isStringLiteralLike(specifier)
            ? specifier.text
            : specifier.getText(file),
          reason: isComputedImport(ts, specifier) ? NOT_LITERAL : NOT_FOUND,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found.sort(byPathAndLine);
}
