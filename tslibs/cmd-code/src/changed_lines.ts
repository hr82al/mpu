/**
 * Изменения рабочего дерева относительно базы (`--base`:
 * `specs/code-literals.md`, `code-shape.md`, `code-twins.md`): как
 * `git diff REF...` вместе с незакоммиченным. Команды по файлам
 * спрашивают строки файла, `code twins` — задет ли отрезок текста тела.
 *
 * Отсутствие базы — не `undefined` в фильтре, а объект «изменены все
 * строки»: печатать ли запись, решает фильтр, а не цикл печати.
 */

import { DomainError, UsageError } from "@mpu/command";
import { ownsRoot, type RunGit } from "./mark.ts";
import { type FilePatch, readPatch, type TextSpan } from "./patch.ts";

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
    const diff = await run([...DIFF, commit, "--", path], root);
    if (diff === null || diff.code !== 0) {
      throw new DomainError(`git diff ${commit} -- ${path} не ответил`);
    }
    // `+N,0` — чистое удаление, новых строк у него нет.
    return new ChangedLines(
      new Set(readPatch(diff.stdout).flatMap((patch) => patch.lines())),
    );
  }

  /**
   * Изменения исходников репозитория против коммита базы: один
   * `git diff` с поиском переименований (переименованный файл без правки
   * кусков не даёт) и неотслеженные файлы. Только `.ts` и `.tsx`: тела
   * есть только у них, а дифф всего дерева падает на любом чужом файле,
   * который git не может прочесть.
   */
  async changes(): Promise<RepoChanges> {
    const { run, root, commit } = this;
    const diff = await run([...DIFF, "-M", commit, "--", ...SOURCES], root);
    if (diff === null || diff.code !== 0) {
      throw new DomainError(`git diff ${commit} не ответил`);
    }
    const untracked = await run([...UNTRACKED, "--", ...SOURCES], root);
    if (untracked === null || untracked.code !== 0) {
      throw new DomainError("git ls-files --others не ответил");
    }
    return new RepoChanges(
      readPatch(diff.stdout),
      untracked.stdout.split("\0").filter((path) => path !== ""),
    );
  }
}

/**
 * `git diff -U0` в форме, которую читает `readPatch`: пути без
 * восьмеричного экранирования и с явными префиксами `a/`, `b/` —
 * настройки `diff.noprefix` и `diff.mnemonicPrefix` их не сдвинут.
 */
const DIFF: readonly string[] = [
  "-c",
  "core.quotePath=false",
  "diff",
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/** Исходники, у которых бывают тела: пути в любом каталоге. */
const SOURCES: readonly string[] = ["*.ts", "*.tsx"];

/** Неотслеженные файлы без игнорируемых, через `\0`. */
const UNTRACKED: readonly string[] = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
];

/** Изменения одного файла рабочего дерева против базы. */
interface FileChanges {
  /** Задет ли отрезок текста файла изменением. */
  touches(span: TextSpan): boolean;
}

/** Файл без изменений: в патче его нет. */
const UNCHANGED: FileChanges = { touches: () => false };

/** Файл, которого git не отслеживает: новый целиком. */
const WHOLE_FILE: FileChanges = { touches: () => true };

/**
 * Изменения репозитория против базы — по файлу рабочего дерева.
 * Неотслеженный файл — новый целиком: `git diff` его не видит.
 */
export class RepoChanges {
  readonly #files = new Map<string, FileChanges>();

  constructor(patches: readonly FilePatch[], untracked: readonly string[]) {
    for (const patch of patches) this.#files.set(patch.path, patch);
    for (const path of untracked) this.#files.set(path, WHOLE_FILE);
  }

  /** Задет ли отрезок текста файла `path` изменением. */
  touches(path: string, span: TextSpan): boolean {
    return (this.#files.get(path) ?? UNCHANGED).touches(span);
  }
}
