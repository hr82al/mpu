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
  Declarations,
  Place,
  Target,
  Unresolved,
} from "./analyzer.ts";
import type { Bodies, Body } from "./body.ts";
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
/**
 * Анализатор репозитория целиком — окно вопроса о занятости имени. От
 * `openAnalyzer` отличается тем, что файла у вопроса нет: проекты
 * берутся все, а их отсутствие само по себе становится причиной отказа.
 */
export async function openRepoAnalyzer(repo: Repo): Promise<Analyzer> {
  const analyzers = await typeAnalyzers(repo);
  if (analyzers.length === 0) {
    return textAnalyzer(
      repo,
      `в репозитории ${repo.name} нет ни одного проекта`,
    );
  }
  return analyzers.length === 1 ? analyzers[0] : merged(analyzers);
}

export async function openAnalyzer(
  repo: Repo,
  path: string,
): Promise<Analyzer> {
  const projects = findProjects(repo.root);
  if (projects.length === 0) {
    return textAnalyzer(
      repo,
      `в репозитории ${repo.name} нет ни одного проекта`,
    );
  }
  const analyzers = await typeAnalyzers(repo);
  if (!analyzers.some((analyzer) => analyzer.hasFile(path))) {
    // Причина у двух случаев разная, и назвать надо ту, что есть:
    // проекты в репозитории могут быть, а адресованный файл — вне их.
    return textAnalyzer(
      repo,
      `файл ${path} не входит ни в один проект репозитория ${repo.name}`,
    );
  }
  return analyzers.length === 1 ? analyzers[0] : merged(analyzers);
}

/** Анализаторы по типам для всех проектов репозитория. */
async function typeAnalyzers(repo: Repo): Promise<readonly Analyzer[]> {
  const projects = findProjects(repo.root);
  if (projects.length === 0) return [];
  const ts = (await import("typescript")).default;
  const analyzers: Analyzer[] = [];
  for (const project of projects) {
    const program = buildProgram(ts, project);
    // Конфигурация без входных файлов проектом не считается: список
    // проектов её отсеивает здесь, где он уже разрешён.
    if (program === undefined) continue;
    analyzers.push(createTypeAnalyzer({
      ts,
      program,
      projectPath: project,
      repoRoot: repo.root,
      mark: repo.mark,
    }));
  }
  return analyzers;
}

function textAnalyzer(repo: Repo, reason: string): Analyzer {
  return createTextAnalyzer({ repoRoot: repo.root, reason, mark: repo.mark });
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
    files: () =>
      [
        ...new Set(analyzers.flatMap((analyzer) => analyzer.files())),
      ].sort(),
    declarationsOf: (path) => declarationsOf(analyzers, path),
    declarationsRefusal: () => null,
    bodiesOf: () => bodiesOf(analyzers),
    consumersOf: (target) => consumersOf(analyzers, target),
    unresolvedOf: () => unresolvedOf(analyzers),
  };
}

/** Объявления файла у первого проекта, который его содержит. */
function declarationsOf(
  analyzers: readonly Analyzer[],
  path: string,
): Declarations {
  // Файла нет ни у кого — пустой перечень: сюда доходят только после
  // `hasFile`, и «файла нет» уже отвечено ошибкой ввода.
  const owner = analyzers.find((analyzer) => analyzer.hasFile(path));
  return owner === undefined
    ? { kind: "known", declarations: [] }
    : owner.declarationsOf(path);
}

/** Тела всех проектов без повторов: файл может входить в два проекта. */
function bodiesOf(analyzers: readonly Analyzer[]): Bodies {
  const bodies = new Map<string, Body>();
  for (const analyzer of analyzers) {
    const answer = analyzer.bodiesOf();
    // Незнание одного проекта и есть ответ операции: молча заменить его
    // пустым перечнем значило бы напечатать «близнецов нет» вместо «не
    // знаю» (`platform/code-analyzer.md`).
    if (answer.kind !== "known") return answer;
    for (const body of answer.bodies) {
      // Текст в ключе: два безымянных тела на одной строке (два
      // колбэка в одном вызове) — разные тела, а не одно.
      bodies.set(`${body.path}:${body.line}:${body.name}:${body.text}`, body);
    }
  }
  return { kind: "known", bodies: [...bodies.values()] };
}

/** Объединение перечней всех проектов без повторов. */
function consumersOf(
  analyzers: readonly Analyzer[],
  target: Target,
): readonly Place[] {
  const places = new Map<string, Place>();
  for (const analyzer of analyzers) {
    // Единица перечня — файл: тот же файл, увиденный двумя проектами,
    // остаётся одной строкой, и строкой меньшей — той, которой символ
    // приходит раньше.
    for (const place of analyzer.consumersOf(target)) {
      const seen = places.get(place.path);
      if (seen === undefined || place.line < seen.line) {
        places.set(place.path, place);
      }
    }
  }
  return [...places.values()].sort(byPathAndLine);
}

/** Неразрешённые ссылки всех проектов без повторов. */
function unresolvedOf(analyzers: readonly Analyzer[]): readonly Unresolved[] {
  const found = new Map<string, Unresolved>();
  for (const analyzer of analyzers) {
    for (const item of analyzer.unresolvedOf()) {
      found.set(`${item.path}:${item.line}:${item.specifier}`, item);
    }
  }
  return [...found.values()].sort(byPathAndLine);
}
