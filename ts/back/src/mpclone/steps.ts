/**
 * Шаг на субрепо (`docs/specs/mp-clone.md`, «Состояние каталога →
 * действие»): каждое состояние каталога — своя реализация одного
 * протокола. План строится probe'ами, и шаг сам знает, что сказать в
 * плане, что сделать и как посчитаться в итоге.
 */

import type { Workspace } from "./workspace.ts";
import type { Disk, Shell } from "./ports.ts";
import { CloneStop, firstLine, urlOf } from "./remote.ts";

/** Что шаг получает на исполнение: порты, корень и печать хода. */
export interface StepContext {
  readonly shell: Shell;
  readonly disk: Disk;
  readonly workspace: Workspace;
  /** Каталог копий этого прогона: `$HOME/tmp/mp-clone-backup/<штамп>`. */
  readonly backupDir: string;
  readonly say: (line: string) => void;
}

/** Итог прогона по субрепо: счёт и имена, стоящие своим `.git`. */
export class Tally {
  private readonly clonedNames: string[] = [];
  private readonly presentNames: string[] = [];
  private readonly absentNames: string[] = [];

  cloned(name: string): void {
    this.clonedNames.push(name);
  }

  present(name: string): void {
    this.presentNames.push(name);
  }

  absent(name: string): void {
    this.absentNames.push(name);
  }

  /** Субрепо со своим `.git` — им место в `.gitignore` корня. */
  repos(): readonly string[] {
    return [...this.presentNames, ...this.clonedNames];
  }

  summary(): string {
    return `mp-clone: ${this.clonedNames.length} склонировано, ` +
      `${this.presentNames.length} уже было, ` +
      `${this.absentNames.length} нет на сервере`;
  }
}

/** Шаг на один субрепо. */
export interface Step {
  /** Строка плана `dry`, без префикса. */
  planned(): string;
  /** Посчитаться в итоге плана — так, как посчитается исполнение. */
  plan(tally: Tally): void;
  /** Исполнить; неудача — `CloneStop`. */
  apply(context: StepContext, tally: Tally): Promise<void>;
}

/** Каталог со своим `.git`: не трогается никогда. */
export class Present implements Step {
  constructor(private readonly name: string, private readonly head: string) {}

  planned(): string {
    return `уже есть: ${this.name} (${this.head})`;
  }

  plan(tally: Tally): void {
    tally.present(this.name);
  }

  apply(context: StepContext, tally: Tally): Promise<void> {
    context.say(this.planned());
    this.plan(tally);
    return Promise.resolve();
  }
}

/** Репозитория нет на сервере: предупреждение, код не меняется. */
export class NotOnServer implements Step {
  constructor(private readonly name: string) {}

  planned(): string {
    return `нет на сервере: ${this.name}`;
  }

  plan(tally: Tally): void {
    tally.absent(this.name);
  }

  apply(context: StepContext, tally: Tally): Promise<void> {
    context.say(this.planned());
    this.plan(tally);
    return Promise.resolve();
  }
}

/** Каталога нет: обычный `git clone`. */
export class Fresh implements Step {
  constructor(private readonly name: string) {}

  planned(): string {
    return `склонирован: ${this.name}`;
  }

  plan(tally: Tally): void {
    tally.cloned(this.name);
  }

  async apply(context: StepContext, tally: Tally): Promise<void> {
    const dir = context.workspace.dirOf(this.name);
    const clone = await context.shell.run([
      "git",
      "clone",
      urlOf(this.name),
      dir,
    ]);
    if (clone.code !== 0) {
      throw new CloneStop(
        `${this.name} — git clone: ${firstLine(clone.stderr)}`,
        1,
      );
    }
    context.say(`${this.planned()} (${await headOf(context.shell, dir)})`);
    this.plan(tally);
  }
}

/**
 * Каталог без своего `.git` — пустышка с локальными файлами. Клон
 * поверх: копия до первой записи, `.git` из клона без checkout,
 * checkout поверх, отличающиеся файлы — обратно из копии.
 */
export class OverDummy implements Step {
  constructor(private readonly name: string, private readonly backup: string) {}

  planned(): string {
    return `поверх пустышки: ${this.name}, копия ${this.backup}`;
  }

  plan(tally: Tally): void {
    tally.cloned(this.name);
  }

  async apply(context: StepContext, tally: Tally): Promise<void> {
    const dir = context.workspace.dirOf(this.name);
    await must(context.shell, ["mkdir", "-p", context.backupDir], this.name);
    await must(context.shell, ["cp", "-a", dir, this.backup], this.name);
    context.say(this.planned());
    try {
      await this.cloneInto(context, dir);
    } catch (err) {
      if (!(err instanceof CloneStop)) throw err;
      await this.restore(context, dir, err);
    }
    await this.returnLocal(context, dir);
    this.plan(tally);
  }

  private async cloneInto(context: StepContext, dir: string): Promise<void> {
    const temp = `${context.backupDir}/.clone-${this.name}`;
    await must(context.shell, [
      "git",
      "clone",
      "--no-checkout",
      urlOf(this.name),
      temp,
    ], this.name);
    await must(
      context.shell,
      ["cp", "-a", `${temp}/.git`, `${dir}/.git`],
      this.name,
    );
    await must(
      context.shell,
      ["git", "-C", dir, "checkout", "-f", "HEAD", "--", "."],
      this.name,
    );
  }

  /** Упал клон — каталог обратно из копии, затем остановка exit 1. */
  private async restore(
    context: StepContext,
    dir: string,
    cause: CloneStop,
  ): Promise<never> {
    try {
      await must(context.shell, ["rm", "-rf", dir], this.name);
      await must(context.shell, ["cp", "-a", this.backup, dir], this.name);
    } catch (err) {
      if (!(err instanceof CloneStop)) throw err;
      throw new CloneStop(
        `${err.message}; каталог не восстановлен — копия ${this.backup}`,
        1,
        { cause },
      );
    }
    throw new CloneStop(
      `${this.name} — clone упал, каталог восстановлен из копии ${this.backup}`,
      1,
      { cause },
    );
  }

  /** Отслеживаемый файл, правленый владельцем, — обратно из копии. */
  private async returnLocal(context: StepContext, dir: string): Promise<void> {
    for (const path of context.disk.filesUnder(this.backup)) {
      const saved = `${this.backup}/${path}`;
      const current = `${dir}/${path}`;
      if (untouched(context.disk, saved, current)) continue;
      await must(context.shell, ["cp", "-a", saved, current], this.name);
      context.say(`восстановлен локальный: ${this.name}/${path}`);
    }
  }
}

/**
 * Checkout не тронул файл копии: байты те же, либо файла в каталоге нет
 * (checkout не удаляет — значит, его и не было в клоне).
 */
function untouched(disk: Disk, saved: string, current: string): boolean {
  if (!disk.exists(current)) return true;
  const a = disk.readBytes(saved);
  const b = disk.readBytes(current);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Вызов, чья неудача останавливает команду с текстом программы. */
async function must(
  shell: Shell,
  argv: readonly string[],
  name: string,
): Promise<void> {
  const outcome = await shell.run(argv);
  if (outcome.code === 0) return;
  throw new CloneStop(
    `${name} — ${argv.slice(0, 2).join(" ")}: ${firstLine(outcome.stderr)}`,
    1,
  );
}

/** `<ветка> <sha>` репозитория — для строк `склонирован`/`уже есть`. */
export async function headOf(shell: Shell, dir: string): Promise<string> {
  const branch = await shell.run([
    "git",
    "-C",
    dir,
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const sha = await shell.run([
    "git",
    "-C",
    dir,
    "rev-parse",
    "--short",
    "HEAD",
  ]);
  return `${branch.stdout.trim()} ${sha.stdout.trim()}`;
}
