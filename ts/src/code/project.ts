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

/** Имя файла проекта; ровно это, без вариантов вроде `*.base.json`. */
const PROJECT_FILE = "tsconfig.json";

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
    if (entry.name === PROJECT_FILE) into.push(path);
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
