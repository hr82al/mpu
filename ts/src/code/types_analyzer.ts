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
import type { MarkSource } from "./mark.ts";
import { dirOf } from "./project.ts";

/** Причина, по которой ссылка не разрешилась; других пока не бывает. */
const NOT_FOUND = "модуль не найден";

/** Что нужно анализатору сверх самой программы. */
export interface TypeAnalyzerDeps {
  readonly ts: typeof TS;
  readonly program: TS.Program;
  readonly repoRoot: string;
  readonly mark: MarkSource;
}

/** Анализатор по типам поверх готовой программы проекта. */
export function createTypeAnalyzer(deps: TypeAnalyzerDeps): Analyzer {
  const { ts, program, repoRoot } = deps;
  const checker = program.getTypeChecker();
  const entry = entryFile(ts, program);
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
    declarationsOf: (path) => {
      const file = fileOf(path);
      return file === undefined ? [] : declarationsIn(ts, checker, file, entry);
    },
    consumersOf: (target) => ({
      places: placesFor(ts, checker, files, fileOf, rel, target),
      unresolved: unresolvedIn(ts, checker, files, rel),
    }),
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
): TS.SourceFile | undefined {
  const roots = program.getRootFileNames();
  if (roots.length === 0) return undefined;
  const declared = declaredEntry(ts, program);
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

/** Файл поля входа пакета рядом с конфигурацией проекта. */
function declaredEntry(
  ts: typeof TS,
  program: TS.Program,
): TS.SourceFile | undefined {
  const configPath = program.getCompilerOptions().configFilePath;
  if (typeof configPath !== "string") return undefined;
  const dir = dirOf(configPath);
  for (const name of ["package.json", "deno.json", "deno.jsonc"]) {
    const path = entryFromManifest(ts, `${dir}/${name}`);
    if (path === undefined) continue;
    const file = program.getSourceFile(`${dir}/${path.replace(/^\.\//, "")}`);
    if (file !== undefined) return file;
  }
  return undefined;
}

/** Значение поля входа манифеста; файла или поля нет — `undefined`. */
function entryFromManifest(ts: typeof TS, path: string): string | undefined {
  const text = ts.sys.readFile(path);
  if (text === undefined) return undefined;
  const parsed = ts.parseConfigFileTextToJson(path, text);
  const manifest = parsed.config;
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const fields = manifest as Record<string, unknown>;
  return firstString([pickExport(fields.exports), fields.main]);
}

/** Строковый вход из поля `exports` в любой из его форм. */
function pickExport(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const root = (value as Record<string, unknown>)["."];
  if (typeof root === "string") return root;
  if (typeof root !== "object" || root === null) return undefined;
  const conditions = root as Record<string, unknown>;
  return firstString([conditions.import, conditions.default]);
}

function firstString(values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
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
      found.push({
        name: symbol.getName(),
        signature: signatureOf(checker, symbol, node.name),
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

/**
 * Сигнатура для человека. У вызываемого — форма вызова целиком, иначе
 * сам тип: `mpu code` не объясняет, что символ делает, но назвать его
 * форму обязана. Двоеточие ставит рендер — здесь оно дало бы
 * `имя : число` с пробелом перед ним.
 */
function signatureOf(
  checker: TS.TypeChecker,
  symbol: TS.Symbol,
  at: TS.Node,
): string {
  const type = checker.getTypeOfSymbolAtLocation(symbol, at);
  const call = type.getCallSignatures();
  return call.length > 0
    ? checker.signatureToString(call[0])
    : checker.typeToString(type);
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

/** Строка, которой файл читает модуль; не читает — `undefined`. */
function readerLine(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  module: TS.SourceFile,
): number | undefined {
  for (const statement of file.statements) {
    const specifier = moduleSpecifierOf(ts, statement);
    if (specifier === undefined) continue;
    if (resolvedFile(ts, checker, specifier) !== module) continue;
    return lineOf(file, statement.getStart(file));
  }
  return undefined;
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
 * Строка импорта или реэкспорта, приводящего символ в файл, — если
 * приводит вовсе. Сверка идёт символ-в-символ, поэтому в перечень
 * попадают и переименованный при импорте символ, и полученный через
 * алиас `paths`, и реэкспорт входа.
 */
function receivingLine(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  symbol: TS.Symbol,
): number | undefined {
  for (const statement of file.statements) {
    const specifier = moduleSpecifierOf(ts, statement);
    if (specifier === undefined) continue;
    const module = checker.getSymbolAtLocation(specifier);
    if (module === undefined) continue;
    const brings = checker.getExportsOfModule(module)
      .some((exported) => resolveAlias(ts, checker, exported) === symbol);
    if (!brings) continue;
    if (!namesSymbol(ts, checker, statement, symbol)) continue;
    return lineOf(file, statement.getStart(file));
  }
  return undefined;
}

/**
 * Берёт ли утверждение именно этот символ. Сверка идёт символ-в-символ
 * у каждой формы, которая имя приносит; формы, которые имён не
 * приносят, отвечают «нет» — иначе в перечень попадает файл, который
 * переименование не сломает, и перечень перестаёт равняться оракулу.
 *
 * `import "./a.ts"` не приносит имён физически, а `export * from
 * "./a.ts"` хоть и реэкспортирует имя, переименованием не ломается:
 * реэкспорт подстроится сам, и оракул такой файл не считает.
 */
function namesSymbol(
  ts: typeof TS,
  checker: TS.TypeChecker,
  statement: TS.Statement,
  symbol: TS.Symbol,
): boolean {
  if (ts.isExportDeclaration(statement)) {
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return false;
    return someResolvesTo(ts, checker, clause.elements, symbol);
  }
  if (!ts.isImportDeclaration(statement)) return false;
  const clause = statement.importClause;
  if (clause === undefined) return false;
  // Импорт по умолчанию: имя одно и сверяется как всякое другое.
  if (
    clause.name !== undefined && resolvesTo(ts, checker, clause.name, symbol)
  ) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamedImports(bindings)) {
    return someResolvesTo(ts, checker, bindings.elements, symbol);
  }
  // Пространство имён приносит модуль целиком, поэтому вопрос решает не
  // импорт, а обращения: `A.addDays` переименование ломает, `A.other` —
  // нет.
  return usesThroughNamespace(ts, checker, statement.getSourceFile(), symbol);
}

/** Есть ли среди узлов тот, чьё имя разрешается в искомый символ. */
function someResolvesTo(
  ts: typeof TS,
  checker: TS.TypeChecker,
  elements: readonly { readonly name: TS.Node }[],
  symbol: TS.Symbol,
): boolean {
  return elements.some((element) =>
    resolvesTo(ts, checker, element.name, symbol)
  );
}

/** Разрешается ли имя узла в искомый символ — сам либо через алиас. */
function resolvesTo(
  ts: typeof TS,
  checker: TS.TypeChecker,
  node: TS.Node,
  symbol: TS.Symbol,
): boolean {
  const local = checker.getSymbolAtLocation(node);
  return local !== undefined && resolveAlias(ts, checker, local) === symbol;
}

/** Есть ли в файле обращение вида `A.имя`, ведущее к искомому символу. */
function usesThroughNamespace(
  ts: typeof TS,
  checker: TS.TypeChecker,
  file: TS.SourceFile,
  symbol: TS.Symbol,
): boolean {
  let found = false;
  const visit = (node: TS.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node)) {
      found = resolvesTo(ts, checker, node.name, symbol);
      if (found) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Литерал модуля у импорта или реэкспорта; иначе `undefined`. */
function moduleSpecifierOf(
  ts: typeof TS,
  statement: TS.Statement,
): TS.Expression | undefined {
  if (ts.isImportDeclaration(statement)) return statement.moduleSpecifier;
  if (ts.isExportDeclaration(statement)) return statement.moduleSpecifier;
  return undefined;
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
    for (const statement of file.statements) {
      const specifier = moduleSpecifierOf(ts, statement);
      if (specifier === undefined) continue;
      if (checker.getSymbolAtLocation(specifier) !== undefined) continue;
      found.push({
        path: rel(file.fileName),
        line: lineOf(file, statement.getStart(file)),
        specifier: ts.isStringLiteral(specifier)
          ? specifier.text
          : specifier.getText(file),
        reason: NOT_FOUND,
      });
    }
  }
  return found.sort(byPathAndLine);
}
