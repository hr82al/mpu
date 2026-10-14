/**
 * Изменённые строки файла относительно базы (`specs/code-literals.md`,
 * `--base`): как `git diff REF...` вместе с незакоммиченным.
 *
 * Отсутствие базы — не `undefined` в фильтре, а объект «изменены все
 * строки»: печатать ли запись, решает фильтр, а не цикл печати.
 */

import { DomainError, UsageError } from "@mpu/command";
import { ownsRoot, type RunGit } from "./mark.ts";

/** Строки файла, которые считаются изменёнными. */
export interface LineFilter {
  /** Задето ли изменением хотя бы одно из вхождений записи. */
  touches(lines: readonly number[]): boolean;
}

/** База, относительно которой ищутся изменённые строки. */
export interface Base {
  linesOf(path: string): Promise<LineFilter>;
}

/** Все строки изменены: без базы и у файла, которого в базе нет. */
const EVERY_LINE: LineFilter = { touches: () => true };

/** Без `--base`: печатается всё. */
export const NO_BASE: Base = { linesOf: () => Promise.resolve(EVERY_LINE) };

class ChangedLines implements LineFilter {
  constructor(private readonly changed: ReadonlySet<number>) {}
  touches(lines: readonly number[]): boolean {
    return lines.some((line) => this.changed.has(line));
  }
}

/** Новая сторона хунка `git diff -U0`: `+начало[,число]`. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

/**
 * База `merge-base REF HEAD` репозитория. Неразрешимая ссылка — ошибка
 * ввода: опечатку в ветке надо назвать, а не ответить пустым фильтром.
 * Корень сверяется первым, как у отметки: каталог с пустым `.git`
 * внутри чужого репозитория получил бы базу соседа, а шапка при этом
 * называла бы его «вне git».
 */
export async function mergeBase(
  run: RunGit,
  root: string,
  ref: string,
): Promise<Base> {
  const found = (await ownsRoot(run, root))
    ? await run(["merge-base", ref, "HEAD"], root)
    : null;
  if (found === null || found.code !== 0) {
    throw new UsageError(
      `базу ${ref} не найти: git merge-base ${ref} HEAD не ответил`,
    );
  }
  const commit = found.stdout.trim();
  return { linesOf: (path) => changedSince(run, root, commit, path) };
}

/**
 * Изменённые строки файла рабочего дерева против коммита базы. Файла в
 * базе нет (новый, ещё не добавленный) — изменён целиком: `git diff` по
 * неотслеженному файлу пуст, и самый частый случай приёмки — новый файл
 * теста — молча выглядел бы чистым.
 */
async function changedSince(
  run: RunGit,
  root: string,
  commit: string,
  path: string,
): Promise<LineFilter> {
  const inBase = await run(["cat-file", "-e", `${commit}:${path}`], root);
  if (inBase === null || inBase.code !== 0) return EVERY_LINE;
  const diff = await run(
    ["diff", "-U0", "--no-color", "--no-ext-diff", commit, "--", path],
    root,
  );
  if (diff === null || diff.code !== 0) {
    throw new DomainError(`git diff ${commit} -- ${path} не ответил`);
  }
  const changed = new Set<number>();
  for (const [, start, count] of diff.stdout.matchAll(HUNK)) {
    // Без числа хунк — одна строка; `+N,0` — чистое удаление, новых
    // строк у него нет.
    const size = count === undefined ? 1 : Number(count);
    for (let line = Number(start); line < Number(start) + size; line++) {
      changed.add(line);
    }
  }
  return new ChangedLines(changed);
}
