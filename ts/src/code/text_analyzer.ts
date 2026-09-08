/**
 * Текстовый анализатор (`platform/code-analyzer.md`): репозиторий без
 * единого проекта и файл, не попавший ни в один из них.
 *
 * Гарантия у него пониженная и названа в шапке каждого раздела: он
 * сверяет имя с именем, а не символ с символом, поэтому тёзка из
 * другого модуля попадает в перечень, а полученный под другим именем —
 * не попадает. Это ответ, а не отказ: «не знаю» подменённое на «нет» —
 * ровно тот дефект, ради которого семейство заводится.
 */

import type { Analyzer, Declaration, Place, Target } from "./analyzer.ts";
import { byPathAndLine } from "./analyzer.ts";
import type { MarkSource } from "./mark.ts";
import { SKIPPED_DIRS } from "./project.ts";

/** Расширения, которые текстовый разбор считает кодом. */
const CODE_SUFFIXES: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
];

/**
 * Объявление в тексте: ключевое слово и имя следом. Стрелочная форма
 * (`const spanDays = (…) => …`) попадает сюда же — она объявляет имя,
 * а вот `function spanDays` её не описывает, и на этом текстовый
 * разбор и проигрывает разбору по типам.
 */
const DECLARATION =
  /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

export interface TextAnalyzerDeps {
  readonly repoRoot: string;
  readonly mark: MarkSource;
}

/** Текстовый анализатор одного репозитория. */
export function createTextAnalyzer(deps: TextAnalyzerDeps): Analyzer {
  const files = codeFiles(deps.repoRoot);
  const textOf = (path: string): string | undefined => {
    try {
      return Deno.readTextFileSync(`${deps.repoRoot}/${path}`);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return undefined;
      throw err;
    }
  };

  return {
    guarantee: "text",
    mark: deps.mark,
    hasFile: (path) => isFile(`${deps.repoRoot}/${path}`),
    declarationsOf: (path) => declarationsIn(textOf(path) ?? ""),
    consumersOf: (target) => ({
      places: places(files, textOf, target),
      // Текстовый разбор ничего не резолвит, поэтому и не разрешить
      // ему нечего: пониженная гарантия названа в шапке целиком.
      unresolved: [],
    }),
  };
}

/**
 * Обычный ли это файл. Через `stat`, а не через попытку чтения:
 * `readTextFileSync` на каталоге бросает `IsADirectory`, и адрес-каталог
 * ронял бы команду внутренней ошибкой вместо «файла нет».
 */
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Объявления текста по возрастанию строки. */
function declarationsIn(text: string): readonly Declaration[] {
  const found: Declaration[] = [];
  text.split("\n").forEach((line, index) => {
    const match = DECLARATION.exec(line);
    if (match === null) return;
    found.push({
      name: match[1],
      // Ни формы объявления, ни области видимости текстовый разбор не
      // знает: типов у него нет, а модуль он не строит. Незнание
      // называется рендером, а не подменяется правдоподобным ответом.
      signature: null,
      line: index + 1,
      scope: "unknown",
    });
  });
  return found;
}

/** Файлы, где цель встречается текстом; единица перечня — файл. */
function places(
  files: readonly string[],
  textOf: (path: string) => string | undefined,
  target: Target,
): readonly Place[] {
  const needle = needleFor(textOf, target);
  if (needle === undefined) return [];
  const found: Place[] = [];
  for (const path of files) {
    if (path === target.path) continue;
    const line = firstMatch(textOf(path) ?? "", needle);
    if (line !== undefined) found.push({ path, line });
  }
  return found.sort(byPathAndLine);
}

/**
 * Признак того, что строка берёт цель. У модуля сверяется последний
 * сегмент пути в кавычках без расширения: точного пути текстовый
 * разбор не знает — резолвить его нечем, и в этом его неполнота.
 */
function needleFor(
  textOf: (path: string) => string | undefined,
  target: Target,
): ((line: string) => boolean) | undefined {
  if (target.kind === "module") {
    const stem = baseStem(target.path);
    return (line) => quoted(line).some((text) => baseStem(text) === stem);
  }
  const declaration = declarationsIn(textOf(target.path) ?? "")
    .find((entry) => entry.line === target.line);
  if (declaration === undefined) return undefined;
  const word = new RegExp(`\\b${escape(declaration.name)}\\b`);
  return (line) => word.test(line);
}

/** Последний сегмент пути без расширения. */
function baseStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

/** Строковые литералы строки — в любых из трёх кавычек. */
function quoted(line: string): readonly string[] {
  return [...line.matchAll(/['"`]([^'"`]*)['"`]/g)].map((match) => match[1]);
}

/** Первая строка текста, где встретилось искомое. */
function firstMatch(
  text: string,
  takes: (line: string) => boolean,
): number | undefined {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (takes(lines[index])) return index + 1;
  }
  return undefined;
}

/** Экранирует спецсимволы регулярного выражения в литеральной части. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Файлы кода репозитория относительно его корня. */
function codeFiles(repoRoot: string): readonly string[] {
  const found: string[] = [];
  collect(repoRoot, "", found);
  return found.sort();
}

function collect(dir: string, prefix: string, into: string[]): void {
  for (const entry of Deno.readDirSync(dir)) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      if (SKIPPED_DIRS.includes(entry.name)) continue;
      collect(`${dir}/${entry.name}`, `${name}/`, into);
      continue;
    }
    if (CODE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      into.push(name);
    }
  }
}
