/**
 * Обход репозиториев рабочей области (`platform/code-analyzer.md`,
 * «Стоимость ответа»).
 *
 * Одно место на четыре поверхности, и в нём три вопроса: какие
 * репозитории берёт окно вопроса, чем они заняты и как их обходят.
 *
 * Обход параллельный, и параллельность здесь — процессы, а не промисы.
 * Замер 2026-09-09 на трёх копиях `ts/` (575 файлов): последовательно
 * 2.97 с, `Promise.all` 2.67 с, тремя воркерами 1.66 с. Разница не
 * случайна: построение программы синхронно от начала до конца
 * (`ts.createProgram`, чекер, `ts.sys.readFile`), и единственное, что
 * `Promise.all` успевает совместить, — вызовы git за отметкой. Отсюда
 * и форма задания: оно **данные**, а не замыкание, потому что уходит в
 * другой поток.
 */

import { z } from "@zod/zod";
import { DomainError, UsageError } from "../command/mod.ts";
import type { Address } from "./address.ts";
import type { TreeMark } from "./mark.ts";
import {
  findWorkspaceRoot,
  readRepos,
  type Repo,
  repoOf,
} from "./workspace.ts";
import { spawnGit } from "./git.ts";

/**
 * Репозиторий, готовый уехать в воркер: отметка уже снята, замыканий
 * нет. Снимается она в главном потоке — там же, где решается порядок
 * разделов, — и в воркер уходит значением.
 */
export interface RepoData {
  readonly name: string;
  readonly root: string;
  readonly mark: TreeMark;
}

/** Задание раздела `mpu code name`. */
export interface NameJob {
  readonly kind: "name";
  readonly repo: RepoData;
  readonly name: string;
  readonly dir: string | undefined;
  readonly limit: number;
}

/** Задание раздела `mpu code mentions`. */
export interface MentionsJob {
  readonly kind: "mentions";
  readonly repo: RepoData;
  readonly path: string;
  readonly dir: string | undefined;
  readonly limit: number;
}

/** Работа одного репозитория. Данные: она пересекает границу потока. */
export type Job = NameJob | MentionsJob;

/** Репозиторий обратно: отметка снята, и анализатору она даётся такой. */
export function asRepo(data: RepoData): Repo {
  return {
    name: data.name,
    root: data.root,
    mark: () => Promise.resolve(data.mark),
  };
}

/**
 * Задания по репозиториям окна. Отметки снимаются здесь и параллельно:
 * это вызовы git, единственная по-настоящему асинхронная работа обхода.
 */
export async function jobsOf<J extends Job>(
  repos: readonly Repo[],
  make: (repo: RepoData) => J,
): Promise<J[]> {
  return await inOrder(
    repos.map((repo) => async () =>
      make({ name: repo.name, root: repo.root, mark: await repo.mark() })
    ),
  );
}

/**
 * Разделы ответа: по одному на задание, в порядке перечня. Порядок
 * задаёт слой (`platform/code-analyzer.md`, «Форма ответа»), поэтому он
 * остаётся свойством перечня, а не порядка готовности воркеров.
 *
 * Одно задание считается на месте: воркер стоит около полусекунды на
 * запуск, и вопрос об одном репозитории — обычный вызов `--in РЕПО` —
 * платил бы её ни за что. Максимум вместо суммы там и без того
 * достигнут: слагаемое одно.
 */
export async function sectionsOf<J extends Job, S>(
  jobs: readonly J[],
  here: (job: J) => Promise<S> | S,
  schema: z.ZodType<S>,
): Promise<S[]> {
  if (jobs.length <= 1) {
    // Схемой разбирается и эта ветка: иначе один репозиторий и
    // несколько отвечали бы через разную проверку, и совпадение формы их
    // ответов держалось бы на случайности.
    return await Promise.all(
      jobs.map(async (job) => schema.parse(await here(job))),
    );
  }
  return await inOrder(
    jobs.map((job) => () => inWorker(job, schema)),
    lanes(jobs.length),
  );
}

/**
 * Сколько заданий считается разом. Предел взят по числу ядер, потому
 * что работа упирается в процессор целиком: сверх этого числа воркеры
 * не считают быстрее, а делят те же ядра — и держат в памяти по
 * программе каждый.
 */
function lanes(count: number): number {
  return Math.min(count, navigator.hardwareConcurrency);
}

/**
 * Результаты в порядке перечня, а не готовности, и первый отказ — тоже
 * по порядку. `Promise.all` отдал бы ошибку, случившуюся раньше по
 * времени: при двух неверных окнах текст ошибки зависел бы от того,
 * какой репозиторий больше, а вывод обязан быть детерминированным.
 *
 * Отказы после первого не печатаются: ответа у команды всё равно нет,
 * а называть один отказ из двух в порядке готовности — то же
 * недетерминированное поведение с другой стороны.
 */
async function inOrder<T>(
  tasks: readonly (() => Promise<T>)[],
  width = tasks.length,
): Promise<T[]> {
  // Ячейку заполняет та полоса, что взяла задачу; к выходу из
  // `Promise.all` заполнены все — незаполненной ячейки не бывает.
  const done: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < tasks.length) {
      const at = next++;
      try {
        done[at] = { status: "fulfilled", value: await tasks[at]() };
      } catch (reason) {
        done[at] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(width, tasks.length) }, lane),
  );
  const values: T[] = [];
  for (const result of done) {
    if (result.status === "rejected") throw result.reason;
    values.push(result.value);
  }
  return values;
}

/** Ответ воркера: раздел либо описанная ошибка. */
type Answer =
  | { readonly kind: "section"; readonly section: unknown }
  | { readonly kind: "error"; readonly error: ErrorData };

/**
 * Ошибка через границу потока. Класс переносится РОЛЬЮ, а не именем:
 * от роли зависит код выхода, а имя у подкласса своё
 * (`ProjectBuildError`, `VerbatimError`), и таблица имён отдавала бы
 * такие ошибки плоским `Error` — то есть необработанным исключением
 * вместо кода 1. Цепочка `cause` не переносится: структурное
 * клонирование её не берёт.
 */
interface ErrorData {
  readonly kind: "usage" | "domain" | "other";
  readonly message: string;
  readonly hint?: string;
  readonly advice?: string;
  readonly details?: string;
}

/** Описывает ошибку для отправки из воркера. */
export function describeError(err: unknown): ErrorData {
  if (err instanceof UsageError) return { kind: "usage", ...carried(err) };
  if (err instanceof DomainError) return { kind: "domain", ...carried(err) };
  return {
    kind: "other",
    message: err instanceof Error ? err.message : String(err),
  };
}

/** Что ошибка контракта несёт сверх текста. */
function carried(err: UsageError | DomainError) {
  return {
    message: err.message,
    hint: err.hint,
    advice: err.advice,
    details: err.details,
  };
}

/**
 * Восстанавливает ошибку воркера на стороне вызывающего. `other` —
 * ошибки, у которых роли контракта нет вовсе (файловая система): они
 * доходят до необработанного исключения ровно так же, как дошли бы при
 * одном репозитории, считаемом на месте.
 */
function restoreError(data: ErrorData): Error {
  switch (data.kind) {
    case "usage":
      return new UsageError(data.message, data);
    case "domain":
      return new DomainError(data.message, data);
    case "other":
      return new Error(data.message);
    default: {
      const unknown: never = data.kind;
      throw new Error(`неизвестная роль ошибки: ${unknown}`);
    }
  }
}

/** Считает задание в отдельном потоке. */
function inWorker<S>(job: Job, schema: z.ZodType<S>): Promise<S> {
  // Ссылка на модуль воркера — `new URL(…, import.meta.url)` дословно:
  // `deno compile` включает воркер в бинарь только в этой форме, а
  // `import.meta.resolve` даёт тот же URL и на исходниках работает, но
  // в собранном бинаре модуль не находится вовсе (замер 2026-09-09,
  // проверка smoke краснела на `Module not found`).
  const worker = new Worker(new URL("./repo_worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise<S>((resolve, reject) => {
    /** Воркер закрывается на КАЖДОМ выходе, включая отказные. */
    const fail = (err: Error): void => {
      worker.terminate();
      reject(err);
    };
    worker.onmessage = (event: MessageEvent<Answer>) => {
      worker.terminate();
      const answer = event.data;
      if (answer.kind === "error") {
        reject(restoreError(answer.error));
        return;
      }
      // Разбор схемой — не формальность: раздел приехал из другого
      // потока, и проверяется он там же, где пересёк границу. Конверт
      // ответа при этом остаётся на аннотации: его форму задаёт
      // соседний модуль, а не чужая сторона.
      try {
        resolve(schema.parse(answer.section));
      } catch (err) {
        reject(err);
      }
    };
    // Ответ, не поддавшийся десериализации, поднимает СВОЁ событие:
    // без этой ветки промис не разрешался бы никогда, а воркер остался
    // бы жив — зависание без диагностики.
    worker.onmessageerror = () =>
      fail(new DomainError(`ответ по ${job.repo.name} не разобран`));
    worker.onerror = (event: ErrorEvent) => {
      // Отказ самого воркера — доменная ошибка, а не отказ раздела: он
      // не про репозиторий, а про то, что считать его было нечем.
      event.preventDefault();
      fail(
        new DomainError(
          `разбор репозитория ${job.repo.name} не выполнен: ${event.message}`,
          { cause: event.error },
        ),
      );
    };
    try {
      worker.postMessage(job);
    } catch (err) {
      // Задание неклонируемо — воркер уже запущен, и закрыть его
      // некому, кроме этой ветки.
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Репозитории рабочей области. Подставленный перечень берётся как
 * есть: дерево-фикстура репозиторием по правилу «подкаталог с `.git`»
 * не является, а проверять команды надо целиком.
 */
function knownRepos(cwd: string, repos?: readonly Repo[]): readonly Repo[] {
  return repos ?? readRepos(findWorkspaceRoot(cwd), spawnGit);
}

/**
 * Репозитории окна: названный в нём либо вся рабочая область. Общий на
 * `name` и `mentions` — правило окна у них одно.
 */
export function windowRepos(
  cwd: string,
  repo: string | undefined,
  repos?: readonly Repo[],
): readonly Repo[] {
  const known = knownRepos(cwd, repos);
  return repo === undefined ? known : [named(known, repo)];
}

/**
 * Репозиторий адреса: названный в нём либо тот, внутри которого лежит
 * рабочий каталог. Общий для всех поверхностей семейства — правило
 * разрешения одно на всех.
 */
export function resolveRepo(
  address: Address,
  cwd: string,
  repos?: readonly Repo[],
): Repo {
  const known = knownRepos(cwd, repos);
  return address.repo === undefined
    ? currentRepo(known, cwd)
    : named(known, address.repo);
}

/** Репозиторий, названный в окне или адресе. */
function named(repos: readonly Repo[], name: string): Repo {
  const found = repos.find((repo) => repo.name === name);
  if (found !== undefined) return found;
  throw new UsageError(`неизвестный репозиторий '${name}'`, {
    details: repos.map((repo) => `  ${repo.name}`).join("\n"),
  });
}

/** Репозиторий текущего каталога; вне репозиториев — отказ. */
function currentRepo(repos: readonly Repo[], cwd: string): Repo {
  const found = repoOf(repos, cwd);
  if (found !== undefined) return found;
  throw new UsageError(
    `каталог ${cwd} вне репозиториев рабочей области`,
    { hint: "mpu code refs РЕПОЗИТОРИЙ:ПУТЬ" },
  );
}
