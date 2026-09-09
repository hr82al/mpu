/**
 * Текстовый анализатор (`platform/code-analyzer.md`): репозиторий без
 * единого проекта и файл, не попавший ни в один из них.
 *
 * Умеет он меньше, чем разбор по типам, и говорит об этом сам. Двух
 * операций у него нет вовсе: объявления и тела он выдать не может —
 * выделить тело без разбора значит угадывать по скобкам, а объявление,
 * записанное стрелкой, текстовый поиск не находит (в дереве-фикстуре
 * это `src/span.ts`). Обе отвечают названным незнанием, и команда
 * превращает его в отказ, а не в пустой раздел: пустой раздел читался
 * бы как «совпадений нет», а это другой ответ.
 *
 * Что ему доступно — читатели модуля: путь модуля из текста выводится
 * честно, с пониженной гарантией.
 */

import type { Analyzer, Place, Target } from "./analyzer.ts";
import { byPathAndLine } from "./analyzer.ts";
import type { MarkSource } from "./mark.ts";
import { walkFiles } from "./tree.ts";

/** Расширения, которые слой считает кодом. */
export const CODE_SUFFIXES: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
];

export interface TextAnalyzerDeps {
  readonly repoRoot: string;
  /**
   * Почему разбора по типам здесь нет. Задаётся снаружи: причин две —
   * в репозитории нет проектов и файл не покрыт ни одним из них, — а
   * различить их может только тот, кто выбирал анализатор.
   */
  readonly reason: string;
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
  const noProject = (what: string): string =>
    `${what} не разбираются текстовым анализатором: ${deps.reason}`;

  return {
    guarantee: "text",
    mark: deps.mark,
    hasFile: (path) => isFile(`${deps.repoRoot}/${path}`),
    files: () => files,
    declarationsOf: () => ({
      kind: "unknown",
      reason: noProject("объявления"),
    }),
    declarationsRefusal: () => noProject("объявления"),
    bodiesOf: () => ({ kind: "unknown", reason: noProject("тела") }),
    consumersOf: (target) => readers(files, textOf, target),
    // Текстовый разбор ничего не резолвит, поэтому и не разрешить ему
    // нечего: пониженная гарантия названа в шапке целиком.
    unresolvedOf: () => [],
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

/**
 * Файлы, где встречается путь модуля. Цель-символ сюда не доходит:
 * объявления текстовый анализатор не выдаёт, и команда отказывает
 * раньше — иначе пришлось бы гадать, какой из идентификаторов строки
 * объявлен.
 */
function readers(
  files: readonly string[],
  textOf: (path: string) => string | undefined,
  target: Target,
): readonly Place[] {
  if (target.kind !== "module") return [];
  const stem = baseStem(target.path);
  const takes = (line: string): boolean =>
    quoted(line).some((text) => baseStem(text) === stem);
  const found: Place[] = [];
  for (const path of files) {
    if (path === target.path) continue;
    const line = firstMatch(textOf(path) ?? "", takes);
    if (line !== undefined) found.push({ path, line });
  }
  return found.sort(byPathAndLine);
}

/**
 * Последний сегмент пути без расширения: точного пути текстовый разбор
 * не знает — резолвить его нечем, и в этом его неполнота.
 */
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

/** Файлы кода репозитория относительно его корня. */
function codeFiles(repoRoot: string): readonly string[] {
  return walkFiles(repoRoot, CODE_SUFFIXES);
}
