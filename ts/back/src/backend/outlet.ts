/**
 * Как собранный ответ строки отдаёт свой stdout
 * (`platform/long-output.md`, §4): целиком — или, у двери агента и сверх
 * порога, файлом, путь к которому идёт в ответе вместо вывода. Решает
 * дверь по итогу прогона строки; форма ответа только спрашивает.
 */

import type { OutputFile } from "../frames/mod.ts";

/** Поле ответа вместо вывода: сам вывод или файл с ним. */
export type Settled =
  | { readonly stdout: string }
  | { readonly file: OutputFile };

/** Отдача итогового stdout собранного ответа. */
export interface Outlet {
  settle(stdout: string): Promise<Settled>;
}

/** Целиком: дверь человека и строка, у которой прогона не было. */
export const WHOLE: Outlet = {
  settle: (stdout) => Promise.resolve({ stdout }),
};

/** Куда и с какого размера вывод уходит файлом (параметры `back`). */
export interface Spill {
  /** Каталог файлов вывода; его читают агенты. */
  readonly dir: string;
  /** Порог в байтах UTF-8: вывод больше него — файлом. */
  readonly threshold: number;
  /** Текущее время, мс: по нему стареют файлы каталога. */
  readonly now: () => number;
  /** Диагностика сервера: файл не записан. */
  readonly diagnose: (line: string) => void;
}

/** Каталог по умолчанию: `/tmp` читают агенты любого клиента. */
export const SPILL_DIR = "/tmp/mpu-out";

/** Порог по умолчанию — 64 КиБ: ниже предела ответа тула у клиентов. */
export const SPILL_THRESHOLD = 64 * 1024;

/** Файлы каталога старше суток удаляются при следующей записи. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/** Прогон строки: имя его записи журнала и коллекция ли результат. */
export interface Run {
  readonly runId: string;
  readonly sliced: boolean;
}

/**
 * Дверь агента: вывод сверх порога — файлом `<dir>/<run_id>.txt`. Файл не
 * записался — ответ целиком, как было до порога, и строка в диагностику:
 * ответ строке важнее файла.
 */
export class FileOutlet implements Outlet {
  readonly #spill: Spill;
  readonly #run: Run;

  constructor(spill: Spill, run: Run) {
    this.#spill = spill;
    this.#run = run;
  }

  async settle(stdout: string): Promise<Settled> {
    const bytes = new TextEncoder().encode(stdout);
    if (bytes.byteLength <= this.#spill.threshold) return { stdout };
    const path = `${this.#spill.dir}/${this.#run.runId}.txt`;
    try {
      await this.#write(path, bytes);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.#spill.diagnose(`mpu-back: вывод не записан в ${path}: ${reason}`);
      return { stdout };
    }
    return {
      file: {
        path,
        bytes: bytes.byteLength,
        lines: linesOf(stdout),
        slice: this.#run.sliced,
      },
    };
  }

  /**
   * Каталог 0700, файл 0600 — только владельцу: в выводе данные клиентов.
   * Права ставятся явно, а не через `mode`: его режет umask. Файл пишется
   * рядом и переименовывается — читатель не увидит половину.
   */
  async #write(path: string, bytes: Uint8Array) {
    const dir = this.#spill.dir;
    await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
    await Deno.chmod(dir, 0o700);
    await sweep(dir, this.#spill.now() - KEEP_MS);
    const temp = `${path}.part`;
    await Deno.writeFile(temp, bytes, { mode: 0o600 });
    await Deno.chmod(temp, 0o600);
    await Deno.rename(temp, path);
  }
}

/** Удаляет файлы каталога, изменённые раньше `before` (мс). */
async function sweep(dir: string, before: number) {
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile) continue;
    const path = `${dir}/${entry.name}`;
    try {
      const modified = (await Deno.stat(path)).mtime?.getTime() ?? before;
      if (modified < before) await Deno.remove(path);
    } catch (err) {
      // Файл убрал соседний прогон между чтением каталога и удалением —
      // цель уборки достигнута.
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
}

/** Строки вывода: переводы строки и хвост без перевода, если он есть. */
function linesOf(stdout: string): number {
  const breaks = stdout.split("\n").length - 1;
  return stdout === "" || stdout.endsWith("\n") ? breaks : breaks + 1;
}
