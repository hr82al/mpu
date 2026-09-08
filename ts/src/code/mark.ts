/**
 * Отметка дерева и шапка раздела (`platform/code-analyzer.md`,
 * «Отметка дерева»).
 *
 * Отметка — отдельная операция слоя, и её источник задаётся при
 * создании анализатора: рабочий источник — git, в тестах подставляется
 * постоянная отметка. Ответ читается с рабочего дерева, а не из
 * объектов git, поэтому шапка обязана называть и незакоммиченные
 * изменения — иначе перечень описывает не то дерево, что на диске.
 */

/** Состояние дерева относительно git. */
export type TreeState =
  | { readonly kind: "out-of-git" }
  | {
    readonly kind: "git";
    /** Имя ветки; отделённая голова — `detached`. */
    readonly branch: string;
    /** Первые восемь знаков полного хэша. */
    readonly commit: string;
    readonly dirty: boolean;
  };

/** Отметка дерева одного репозитория. */
export interface TreeMark {
  readonly repo: string;
  readonly state: TreeState;
}

/** Снимок отметки на момент вызова; кэша у слоя нет. */
export type MarkSource = () => Promise<TreeMark>;

/**
 * Гарантия анализатора. Печатается всегда, а не только пониженная:
 * отсутствие строки читалось бы как «полон».
 */
export type Guarantee = "types" | "text";

/** Длина хэша в отметке: фиксирована ради детерминизма вывода. */
const COMMIT_CHARS = 8;

/** Запуск `git <args>` в каталоге; `null` — git нет в PATH. */
export type RunGit = (
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly code: number; readonly stdout: string } | null>;

/**
 * Отметка дерева `root` под именем `repo`. Дерево вне git — ответ
 * `вне git`, а не отказ: репозиторием рабочей области каталог быть
 * перестаёт, но прочитать его файлы это не мешает.
 */
export async function gitTreeMark(
  run: RunGit,
  root: string,
  repo: string,
): Promise<TreeMark> {
  // Корень сверяется первым: `git` от рабочего каталога поднимается
  // вверх, и каталог с пустым или битым `.git` получил бы ветку, хэш и
  // признак изменений СОСЕДНЕГО репозитория — ответ про чужое дерево
  // под именем своего (замер 2026-09-08).
  const top = await run(["rev-parse", "--show-toplevel"], root);
  if (top === null || top.code !== 0 || top.stdout.trim() !== root) {
    return { repo, state: { kind: "out-of-git" } };
  }
  const head = await run(["rev-parse", "HEAD"], root);
  if (head === null || head.code !== 0) {
    return { repo, state: { kind: "out-of-git" } };
  }
  const branch = await run(["symbolic-ref", "--short", "HEAD"], root);
  const status = await run(["status", "--porcelain"], root);
  return {
    repo,
    state: {
      kind: "git",
      // Отделённая голова: `symbolic-ref` отвечает ненулевым кодом, и
      // это не сбой, а второе штатное состояние головы.
      branch: branch === null || branch.code !== 0
        ? "detached"
        : branch.stdout.trim(),
      commit: head.stdout.trim().slice(0, COMMIT_CHARS),
      // Недоступный `status` не имеет права выглядеть чистым деревом.
      dirty: status === null || status.code !== 0 ||
        status.stdout.trim() !== "",
    },
  };
}

/**
 * Шапка раздела: поля через ` · `, последним — гарантия анализатора
 * (`platform/code-analyzer.md`, «Отметка дерева»).
 */
export function renderMark(mark: TreeMark, guarantee: Guarantee): string {
  const promise = guarantee === "types"
    ? "разбор по типам — ответ полон"
    : "текстовый разбор — ответ неполон";
  if (mark.state.kind === "out-of-git") {
    return `${mark.repo} · вне git · ${promise}`;
  }
  const state = mark.state.dirty
    ? "дерево содержит незакоммиченные изменения"
    : "дерево чистое";
  return [mark.repo, mark.state.branch, mark.state.commit, state, promise]
    .join(" · ");
}

/**
 * Шапка раздела, который не ответил: та же отметка без поля гарантии.
 * Гарантия — свойство ответа, она говорит, насколько полон перечень; там,
 * где перечня нет, заявлять о полноте нечего
 * (`platform/code-analyzer.md`).
 */
export function renderMarkOnly(mark: TreeMark): string {
  if (mark.state.kind === "out-of-git") return `${mark.repo} · вне git`;
  const state = mark.state.dirty
    ? "дерево содержит незакоммиченные изменения"
    : "дерево чистое";
  return [mark.repo, mark.state.branch, mark.state.commit, state].join(" · ");
}

/** Короткая форма отметки для сообщений об ошибках: без гарантии. */
export function markLabel(mark: TreeMark): string {
  if (mark.state.kind === "out-of-git") return "вне git";
  return `${mark.state.branch} ${mark.state.commit}`;
}
