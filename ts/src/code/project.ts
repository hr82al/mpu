/**
 * Проекты репозитория и построение их программ
 * (`platform/code-analyzer.md`, «Ввод/вывод»).
 *
 * Отдельно от самого разбора, потому что здесь решаются два вопроса,
 * которые дают измеримую разницу в ответе: какие файлы вообще попадают
 * в программу и по каким правилам резолвятся их импорты. Оба
 * закреплены тестом полноты.
 */

import type TS from "typescript";
import { DomainError } from "../command/mod.ts";

/**
 * Имена файлов проекта. `tsconfig.json` — ровно это, без вариантов вроде
 * `*.base.json`; `deno.json`/`deno.jsonc` — корень конфигурации Deno.
 * Второй вид обязателен: без него репозиторий на Deno не имеет проектов
 * вовсе, и команда отказывает по нему на любой вопрос о символе.
 */
const PROJECT_FILES: readonly string[] = [
  "tsconfig.json",
  "deno.json",
  "deno.jsonc",
];

/** Расширения, которые состав deno-проекта включает. */
const DENO_SUFFIXES: readonly string[] = [".ts", ".tsx"];

/**
 * Каталоги, внутрь которых обход дерева не идёт: зависимости, артефакты
 * сборки и служебный каталог git. Общие на оба анализатора — иначе одно
 * изменение требования пришлось бы вносить в двух местах.
 */
export const SKIPPED_DIRS: readonly string[] = ["node_modules", "dist", ".git"];

/**
 * Пути `tsconfig.json` репозитория. Список нигде не зашит: он
 * снимается с диска на каждый вызов, потому что кэш, собранный на одной
 * ветке и прочитанный на другой, уверенно врёт.
 */
export function findProjects(repoRoot: string): readonly string[] {
  const found: string[] = [];
  collectProjects(repoRoot, found);
  return found.sort();
}

function collectProjects(dir: string, into: string[]): void {
  for (const entry of readDirSorted(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (SKIPPED_DIRS.includes(entry.name)) continue;
      collectProjects(path, into);
      continue;
    }
    if (PROJECT_FILES.includes(entry.name)) into.push(path);
  }
}

/** Записи каталога в стабильном порядке; каталога нет — пусто. */
function readDirSorted(dir: string): readonly Deno.DirEntry[] {
  try {
    return [...Deno.readDirSync(dir)].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

/** Код диагностики TypeScript «в конфигурации не нашлось файлов». */
const NO_INPUTS = 18003;

/**
 * Строит программу проекта со снятыми исключениями кода
 * (`platform/code-analyzer.md`, «Исключения тестов снимаются»).
 *
 * `exclude` заменяется не пустым списком, а фиксированным: пустой
 * затянул бы в программу зависимости у проекта с `include: ["**\/*"]`.
 * Снимаются исключения кода — и никакие исключения артефактов.
 *
 * `undefined` — у конфигурации не разрешается ни одного файла, и
 * проектом она по спеке не считается: так выглядят solution-style и
 * шаблонные конфиги. Отказом это быть не может — соседний рабочий
 * проект того же репозитория лёг бы вместе с ней.
 */
export function buildProgram(
  ts: typeof TS,
  projectPath: string,
): TS.Program | undefined {
  const dir = dirOf(projectPath);
  if (!projectPath.endsWith("/tsconfig.json")) {
    return denoProgram(ts, projectPath, dir);
  }
  const read = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (read.error !== undefined) {
    throw new DomainError(
      `конфигурация проекта ${projectPath} не читается: ${
        ts.flattenDiagnosticMessageText(read.error.messageText, " ")
      }`,
    );
  }
  const config = asRecord(read.config);
  config.exclude = artefactExcludes(config);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir);
  // Пустой список файлов отличается от ошибки разбора кодом, а не
  // текстом: текст локализуется, код — нет.
  if (parsed.errors.some((error) => error.code === NO_INPUTS)) return undefined;
  const broken = parsed.errors.find((error) => error.code !== NO_INPUTS);
  if (broken !== undefined) {
    throw new DomainError(
      `конфигурация проекта ${projectPath} не разбирается: ${
        ts.flattenDiagnosticMessageText(broken.messageText, " ")
      }`,
    );
  }
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/**
 * Программа deno-проекта. Опции задаёт слой, а не конфигурация: у Deno
 * их часть подразумевается рантаймом, и в файле конфигурации их обычно
 * нет вовсе — прочитанный «как есть» проект не собрался бы на первом же
 * импорте с расширением `.ts`.
 */
function denoProgram(
  ts: typeof TS,
  projectPath: string,
  dir: string,
): TS.Program | undefined {
  const read = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (read.error !== undefined) {
    throw new DomainError(
      `конфигурация проекта ${projectPath} не читается: ${
        ts.flattenDiagnosticMessageText(read.error.messageText, " ")
      }`,
    );
  }
  const files = denoFiles(dir, "", excludesOf(asRecord(read.config)));
  // Ни одного исходника — проектом такая конфигурация не считается, как
  // и `tsconfig.json` с пустым списком файлов.
  if (files.length === 0) return undefined;
  return ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // Импорт с расширением `.ts` — обычная форма записи в Deno, и без
    // этой опции компилятор бракует её как ошибку, а не разрешает.
    allowImportingTsExtensions: true,
    strict: true,
    noEmit: true,
  });
}

/**
 * Пути `exclude` конфигурации Deno в нормальной форме: без ведущего
 * `./` и хвостовых `/`. Глобы здесь не раскрываются — сравнение идёт по
 * имени и по префиксу каталога; шаблон вроде `**\/*.js` не совпадёт ни
 * с чем, и файл останется в составе. Это названо отклонением, а не
 * молчаливым упрощением: спека говорит «вне `exclude`», а во что
 * раскрывать шаблоны — не говорит.
 */
function excludesOf(config: Record<string, unknown>): readonly string[] {
  const excluded = config.exclude;
  if (!Array.isArray(excluded)) return [];
  return excluded
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, ""));
}

/**
 * Исключён ли путь. Сравнение точное, без проверки «лежит под
 * названным»: обход спрашивает на каждом уровне, и каталог, названный в
 * `exclude`, отсекается раньше, чем дело дойдёт до его содержимого —
 * мутация показала, что префиксная ветка недостижима.
 */
function isExcluded(path: string, excluded: readonly string[]): boolean {
  return excluded.includes(path);
}

/** Исходники deno-проекта: `.ts`/`.tsx` каталога вне исключений. */
function denoFiles(
  dir: string,
  prefix: string,
  excluded: readonly string[],
): readonly string[] {
  const found: string[] = [];
  for (const entry of readDirSorted(dir)) {
    const name = `${prefix}${entry.name}`;
    if (isExcluded(name, excluded)) continue;
    if (entry.isDirectory) {
      if (SKIPPED_DIRS.includes(entry.name)) continue;
      found.push(...denoFiles(`${dir}/${entry.name}`, `${name}/`, excluded));
      continue;
    }
    if (DENO_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      found.push(`${dir}/${entry.name}`);
    }
  }
  return found;
}

/** Исключения артефактов сборки; исключения кода сюда не попадают. */
function artefactExcludes(config: Record<string, unknown>): readonly string[] {
  const options = asRecord(config.compilerOptions);
  const outDir = typeof options.outDir === "string" ? options.outDir : "dist";
  return ["**/node_modules/**", `${outDir}/**`];
}

/**
 * Значение как объект. Конфигурация проекта приходит из файла, поэтому
 * её форма — предположение, а не факт: не объект равнозначен пустому.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

/** Каталог пути; путей без разделителя здесь не бывает. */
export function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
