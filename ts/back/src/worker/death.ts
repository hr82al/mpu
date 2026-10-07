/**
 * Чем кончился исполнитель, не отдав результата
 * (`platform/line-executor.md`, «Защита от нехватки памяти»): убил ли
 * его сторож за память (отметка в каталоге сторожа), упал ли он сам
 * сигналом или кодом. Ответ — ошибка, которую строка печатает как свой
 * отказ: текст дословно, код 1.
 */

import { readFile, rm, stat } from "node:fs/promises";
import { VerbatimError } from "../command/mod.ts";
import { hasErrorCode } from "../oserror/mod.ts";

/** Как кончился процесс исполнителя. */
export interface ExitStatus {
  readonly code: number;
  /** Сигнал, которым он убит (имя, `SIGSEGV`); кончился сам — `null`. */
  readonly signal: string | null;
}

/** Сигналы, которыми гасят исполнителя. */
export type StopSignal = "SIGTERM" | "SIGKILL";

/** Номера сигналов, которыми гасят исполнителя. */
const SIGNAL_NUMBERS: Record<StopSignal, number> = {
  SIGTERM: 15,
  SIGKILL: 9,
};

/**
 * Статус процесса, убитого сигналом: код — 128 + номер сигнала, как его
 * отдаёт ОС. Нужен тем, кто «убивает» без настоящего процесса.
 */
export function killedStatus(signal: StopSignal): ExitStatus {
  return { code: 128 + SIGNAL_NUMBERS[signal], signal };
}

/** Отметка сторожа об убитом исполнителе — или её отсутствие. */
export interface Mark {
  /** Ошибка строки при смерти сигналом с номером `signal`. */
  error(signal: number): Error;
}

/** Отметки нет: исполнитель упал сам. */
const NO_MARK: Mark = {
  error: (signal) =>
    new VerbatimError(`mpu-back: исполнитель строки упал (сигнал ${signal})`),
};

/** Отметка сторожа: сколько МиБ занимала строка. */
function starved(mib: number): Mark {
  return {
    error: () =>
      new VerbatimError(
        "mpu-back: строка остановлена: машине не хватает памяти, " +
          `строка заняла ${mib} МиБ`,
      ),
  };
}

/** Отметки сторожа: `$XDG_RUNTIME_DIR/mpu/killed/<pid>`. */
export interface Markers {
  /**
   * Отметка об исполнителе `pid`, запущенном в момент `since` (мс):
   * читается и убирается. Отметка старше запуска — о прежнем владельце
   * того же pid, и строке она не принадлежит.
   */
  take(pid: number, since: number): Promise<Mark>;
}

/** Каталога отметок нет (`XDG_RUNTIME_DIR` не задан): отметок не бывает. */
export const NO_MARKERS: Markers = {
  take: () => Promise.resolve(NO_MARK),
};

/** Сколько МиБ в отметке: десятичное целое; иное — не отметка. */
function mibOf(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** Отметки в каталоге сторожа. */
export class MarkerDir implements Markers {
  readonly #dir: string;

  /** @param dir каталог отметок (`$XDG_RUNTIME_DIR/mpu/killed`) */
  constructor(dir: string) {
    this.#dir = dir;
  }

  async take(pid: number, since: number): Promise<Mark> {
    const path = `${this.#dir}/${pid}`;
    let text: string;
    let written: number;
    try {
      written = (await stat(path)).mtime.getTime();
      text = await readFile(path, "utf8");
      await rm(path);
    } catch (err) {
      if (hasErrorCode(err, "ENOENT")) return NO_MARK;
      throw err;
    }
    const mib = mibOf(text);
    if (mib === undefined || written < since) return NO_MARK;
    return starved(mib);
  }
}

/**
 * Ошибка строки, чей исполнитель кончился без результата.
 *
 * @param status как кончился процесс
 * @param mark отметка сторожа о нём
 */
export function deathOf(status: ExitStatus, mark: Mark): Error {
  // Код процесса, убитого сигналом, — 128 + номер сигнала.
  if (status.signal !== null) return mark.error(status.code - 128);
  return new VerbatimError(
    `mpu-back: исполнитель строки упал (код ${status.code})`,
  );
}

/** Ошибка строки, чей исполнитель не запустился вовсе. */
export function unlaunched(err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);
  return new VerbatimError(
    `mpu-back: исполнитель строки не запустился: ${reason}`,
    { cause: err },
  );
}
