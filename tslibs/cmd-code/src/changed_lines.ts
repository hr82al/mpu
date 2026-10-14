/**
 * Изменённые строки файла относительно базы (`specs/code-literals.md`,
 * `--base`): как `git diff REF...` вместе с незакоммиченным.
 *
 * Отсутствие базы — не `undefined` в фильтре, а объект «изменены все
 * строки»: печатать ли запись, решает фильтр, а не цикл печати.
 */

import { DomainError, UsageError } from "@mpu/command";
import { ownsRoot, type RunGit } from "./mark.ts";
import { readHunks } from "./patch.ts";

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
): Promise<MergeBase> {
  const found = (await ownsRoot(run, root))
    ? await run(["merge-base", ref, "HEAD"], root)
    : null;
  if (found === null || found.code !== 0) {
    throw new UsageError(
      `базу ${ref} не найти: git merge-base ${ref} HEAD не ответил`,
    );
  }
  return new MergeBase(run, root, found.stdout.trim());
}

/** Коммит базы в репозитории `root`. */
export class MergeBase implements Base {
  constructor(
    private readonly run: RunGit,
    private readonly root: string,
    private readonly commit: string,
  ) {}

  /**
   * Изменённые строки файла рабочего дерева против коммита базы. Файла в
   * базе нет (новый, ещё не добавленный) — изменён целиком: `git diff` по
   * неотслеженному файлу пуст, и самый частый случай приёмки — новый файл
   * теста — молча выглядел бы чистым.
   */
  async linesOf(path: string): Promise<LineFilter> {
    const { run, root, commit } = this;
    const inBase = await run(["cat-file", "-e", `${commit}:${path}`], root);
    if (inBase === null || inBase.code !== 0) return EVERY_LINE;
    const diff = await run(
      ["diff", "-U0", "--no-color", "--no-ext-diff", commit, "--", path],
      root,
    );
    if (diff === null || diff.code !== 0) {
      throw new DomainError(`git diff ${commit} -- ${path} не ответил`);
    }
    // `+N,0` — чистое удаление, новых строк у него нет.
    return new ChangedLines(
      new Set(readHunks(diff.stdout).flatMap((hunk) => hunk.lines())),
    );
  }
}
