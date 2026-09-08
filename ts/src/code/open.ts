/**
 * Выбор анализатора под цель (`platform/code-analyzer.md`): файл,
 * покрытый проектом, разбирается по типам, всё остальное — текстом.
 *
 * Проекты репозитория обходятся ВСЕ, а не до первого совпадения:
 * оракул полноты считает сборкой весь репозиторий, а потребитель
 * символа из `pa` может жить в `pb`. Ответ первого попавшегося проекта
 * был бы неполон под шапкой «ответ полон» — то есть уверенно неверен.
 *
 * Компилятор загружается динамическим импортом здесь, на ветке самого
 * разбора: пакет тяжёлый, а старт процесса — доказанная ценность
 * `mpu`, поэтому вызов `mpu version` знать о нём не должен.
 */

import type {
  Analyzer,
  Consumers,
  Declaration,
  Place,
  Target,
  Unresolved,
} from "./analyzer.ts";
import { byPathAndLine } from "./analyzer.ts";
import { buildProgram, findProjects } from "./project.ts";
import { createTextAnalyzer } from "./text_analyzer.ts";
import { createTypeAnalyzer } from "./types_analyzer.ts";
import type { Repo } from "./workspace.ts";

/**
 * Анализатор репозитория `repo` под файл `path`. Файл, не попавший ни
 * в один проект, обслуживается текстовым анализатором — как и
 * репозиторий без единого проекта.
 */
export async function openAnalyzer(
  repo: Repo,
  path: string,
): Promise<Analyzer> {
  const projects = findProjects(repo.root);
  if (projects.length === 0) return textAnalyzer(repo);
  const ts = (await import("typescript")).default;
  const analyzers: Analyzer[] = [];
  for (const project of projects) {
    const program = buildProgram(ts, project);
    // Конфигурация без входных файлов проектом не считается: список
    // проектов её отсеивает здесь, где он уже разрешён.
    if (program === undefined) continue;
    analyzers.push(
      createTypeAnalyzer({ ts, program, repoRoot: repo.root, mark: repo.mark }),
    );
  }
  if (!analyzers.some((analyzer) => analyzer.hasFile(path))) {
    return textAnalyzer(repo);
  }
  return analyzers.length === 1 ? analyzers[0] : merged(analyzers);
}

function textAnalyzer(repo: Repo): Analyzer {
  return createTextAnalyzer({ repoRoot: repo.root, mark: repo.mark });
}

/**
 * Анализатор поверх нескольких программ одного репозитория: перечни
 * объединяются, повторы снимаются. Объявления берутся у того проекта,
 * который файл содержит: область видимости — свойство проекта, и
 * усреднять её между проектами нечего.
 */
function merged(analyzers: readonly Analyzer[]): Analyzer {
  return {
    guarantee: "types",
    mark: analyzers[0].mark,
    hasFile: (path) => analyzers.some((analyzer) => analyzer.hasFile(path)),
    declarationsOf: (path) => declarationsOf(analyzers, path),
    consumersOf: (target) => consumersOf(analyzers, target),
  };
}

/** Объявления файла у первого проекта, который его содержит. */
function declarationsOf(
  analyzers: readonly Analyzer[],
  path: string,
): readonly Declaration[] {
  const owner = analyzers.find((analyzer) => analyzer.hasFile(path));
  return owner === undefined ? [] : owner.declarationsOf(path);
}

/** Объединение ответов всех проектов без повторов. */
function consumersOf(
  analyzers: readonly Analyzer[],
  target: Target,
): Consumers {
  const places = new Map<string, Place>();
  const unresolved = new Map<string, Unresolved>();
  for (const analyzer of analyzers) {
    const answer = analyzer.consumersOf(target);
    // Единица перечня — файл: тот же файл, увиденный двумя проектами,
    // остаётся одной строкой, и строкой меньшей — той, которой символ
    // приходит раньше.
    for (const place of answer.places) {
      const seen = places.get(place.path);
      if (seen === undefined || place.line < seen.line) {
        places.set(place.path, place);
      }
    }
    for (const item of answer.unresolved) {
      unresolved.set(`${item.path}:${item.line}:${item.specifier}`, item);
    }
  }
  return {
    places: [...places.values()].sort(byPathAndLine),
    unresolved: [...unresolved.values()].sort(byPathAndLine),
  };
}
