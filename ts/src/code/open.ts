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
 * Анализатор репозитория целиком — окно вопроса о занятости имени. От
 * `openAnalyzer` отличается тем, что файла у вопроса нет: проекты
 * берутся все, а их отсутствие само по себе становится причиной отказа.
 */
export async function openRepoAnalyzer(repo: Repo): Promise<Analyzer> {
  const built = await typeAnalyzers(repo);
  if (built.kind === "none") {
    return textAnalyzer(repo, refusalOf(repo.name, built.cause));
  }
  const analyzers = built.analyzers;
  return analyzers.length === 1 ? analyzers[0] : merged(analyzers);
}

/**
 * Анализатор репозитория `repo` под файл `path`. Текстовым
 * анализатором обслуживаются три случая, и причина у каждого своя:
 * конфигураций проектов нет вовсе, конфигурации есть — а непустого
 * состава ни у одной, и файл не попал ни в одну построенную программу.
 */
export async function openAnalyzer(
  repo: Repo,
  path: string,
): Promise<Analyzer> {
  const built = await typeAnalyzers(repo);
  if (built.kind === "none") {
    return textAnalyzer(repo, refusalOf(repo.name, built.cause));
  }
  const analyzers = built.analyzers;
  if (!analyzers.some((analyzer) => analyzer.hasFile(path))) {
    // Третья причина, и назвать надо ту, что есть: программы здесь уже
    // построились, а адресованный файл не вошёл ни в одну.
    return textAnalyzer(
      repo,
      `файл ${path} не входит ни в один проект репозитория ${repo.name}`,
    );
  }
  return analyzers.length === 1 ? analyzers[0] : merged(analyzers);
}

/**
 * Разбора по типам в репозитории нет, и вот при каком условии.
 * `no-configs` — конфигураций проектов не нашлось вовсе; `no-programs`
 * — конфигурации есть, а состав у всех пуст, и проектом ни одна по
 * спеке не считается.
 */
interface NoAnalyzers {
  readonly kind: "none";
  readonly cause: "no-configs" | "no-programs";
}

/** Чем ответили проекты репозитория. */
type TypeAnalyzers =
  | { readonly kind: "analyzers"; readonly analyzers: readonly Analyzer[] }
  | NoAnalyzers;

/**
 * Почему разбора по типам в репозитории нет. Условие называется своё:
 * «проектов нет» там, где конфигурации есть, а состав их пуст, было бы
 * неправдой — искать пришлось бы не то (`platform/code-analyzer.md`,
 * «Граничные случаи»).
 */
function refusalOf(repoName: string, cause: NoAnalyzers["cause"]): string {
  switch (cause) {
    case "no-configs":
      return `в репозитории ${repoName} нет ни одного проекта`;
    case "no-programs":
      return `в репозитории ${repoName} есть конфигурации проектов, ` +
        "но ни одна программа не собралась непустой";
    default: {
      const unknown: never = cause;
      throw new Error(`неизвестная причина отказа: ${unknown}`);
    }
  }
}

/** Анализаторы по типам для всех проектов репозитория. */
async function typeAnalyzers(repo: Repo): Promise<TypeAnalyzers> {
  const projects = findProjects(repo.root);
  if (projects.length === 0) return { kind: "none", cause: "no-configs" };
  const ts = (await import("typescript")).default;
  const analyzers: Analyzer[] = [];
  for (const project of projects) {
    const program = buildProgram(ts, project, repo.root);
    // Конфигурация без входных файлов проектом не считается: список
    // проектов её отсеивает здесь, где он уже разрешён.
    if (program === undefined) continue;
    analyzers.push(createTypeAnalyzer({
      ts,
      program,
      projectPath: project.path,
      repoRoot: repo.root,
      mark: repo.mark,
    }));
  }
  return analyzers.length === 0
    ? { kind: "none", cause: "no-programs" }
    : { kind: "analyzers", analyzers };
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
