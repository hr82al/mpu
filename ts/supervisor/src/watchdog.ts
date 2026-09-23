/**
 * Сторож памяти (`platform/line-executor.md`, «Защита от нехватки
 * памяти»): раз в такт смотрит, сколько памяти осталось у машины и
 * сколько занимают исполнители строк, и при нехватке убивает самого
 * большого исполнителя, если он больше порога размера. Ядро `mpu-back`
 * он не трогает никогда: оно не исполнитель.
 */

import type { Log } from "./child.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** Процесс машины: родство, память, имя программы. */
export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  /** Резидентная память, байты. */
  readonly rss: number;
  /** Имя программы (`comm`). */
  readonly comm: string;
}

/** Снимок машины на такт. */
export interface Snapshot {
  /** `MemAvailable`, байты. */
  readonly available: number;
  /** `MemTotal`, байты. */
  readonly total: number;
  readonly processes: readonly Proc[];
}

/** Откуда сторож берёт снимок машины. */
export interface ProcSource {
  read(): Promise<Snapshot>;
}

/** Чем сторож убивает и как помечает убитого. */
export interface Hands {
  /** Отметка для ядра: исполнитель `pid` убит за память, занимал `mib`. */
  mark(pid: number, mib: number): Promise<void>;
  kill(pid: number): Promise<void>;
}

/** Порог нехватки по умолчанию: меньшее из 10 % памяти и 1 ГиБ. */
export function defaultThreshold(total: number): number {
  return Math.min(total / 10, GIB);
}

/** Размер, до которого исполнителя не трогают: 256 МиБ. */
export const DEFAULT_MIN_BYTES = 256 * MIB;

/** Такт сторожа. */
export const WATCH_INTERVAL_MS = 1_000;

/** Что нужно сторожу. */
export interface WatchdogParts {
  readonly source: ProcSource;
  readonly hands: Hands;
  /** Пауза между тактами; `signal` прерывает её раньше. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log: Log;
  /** pid ядра `mpu-back`; ядра нет — 0. */
  readonly core: () => number;
  /** Имя программы исполнителя (`mpu-worker`). */
  readonly comm: string;
  /** Порог нехватки по `MemTotal`, байты. */
  readonly threshold: (total: number) => number;
  /** Исполнитель не больше этого — не виновник, байты. */
  readonly minBytes: number;
  readonly intervalMs: number;
}

/** Сторож без ядра и лога: их даёт супервизор. */
export type WatchSetup = Omit<WatchdogParts, "core" | "log">;

/** Потомки `root` по родству снимка. */
function descendants(processes: readonly Proc[], root: number): Proc[] {
  const inside = new Set([root]);
  const found: Proc[] = [];
  // Родитель в выводе `ps` не обязан идти раньше потомка: круг до
  // неподвижной точки.
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of processes) {
      if (inside.has(proc.pid) || !inside.has(proc.ppid)) continue;
      inside.add(proc.pid);
      found.push(proc);
      grew = true;
    }
  }
  return found;
}

/** Сторож исполнителей одного ядра. */
export class Watchdog {
  readonly #parts: WatchdogParts;

  constructor(parts: WatchdogParts) {
    this.#parts = parts;
  }

  /** Один такт: убит ли кто-нибудь — видно по отметке и логу. */
  async tick(): Promise<void> {
    const { source, hands, core, comm, threshold, minBytes } = this.#parts;
    const root = core();
    if (root === 0) return;
    const snapshot = await source.read();
    if (snapshot.available >= threshold(snapshot.total)) return;
    const workers = descendants(snapshot.processes, root)
      .filter((proc) => proc.comm === comm);
    const biggest = workers.reduce<Proc | undefined>(
      (big, proc) => big === undefined || proc.rss > big.rss ? proc : big,
      undefined,
    );
    // Исполнители малы — память ест не `mpu`, убивать некого.
    if (biggest === undefined || biggest.rss <= minBytes) return;
    const mib = Math.round(biggest.rss / MIB);
    await hands.mark(biggest.pid, mib);
    await hands.kill(biggest.pid);
    this.#parts.log.err(
      `[supervisor] сторож: памяти ${Math.round(snapshot.available / MIB)} ` +
        `МиБ, убит исполнитель ${biggest.pid} (${mib} МиБ)`,
    );
  }

  /** Такты до `signal`; сбой такта — строка в лог, сторож живёт дальше. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#parts.log.err(`[supervisor] сторож: ${reason}`);
      }
      await this.#parts.sleep(this.#parts.intervalMs, signal);
    }
  }
}

/** Значение поля `/proc/meminfo` в байтах; поля нет — 0. */
function meminfoField(text: string, name: string): number {
  const match = text.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m"));
  return match === null ? 0 : Number(match[1]) * 1024;
}

/**
 * Процессы из вывода `ps -e -o pid=,ppid=,rss=,comm=`: RSS — в КиБ, имя
 * программы — остаток строки (в нём бывают пробелы).
 */
export function processesOf(text: string): Proc[] {
  const processes: Proc[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (match === null) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss: Number(match[3]) * 1024,
      comm: match[4].trim(),
    });
  }
  return processes;
}

/** Снимок из текстов `/proc/meminfo` и вывода `ps`. */
export function snapshotOf(meminfo: string, ps: string): Snapshot {
  return {
    available: meminfoField(meminfo, "MemAvailable"),
    total: meminfoField(meminfo, "MemTotal"),
    processes: processesOf(ps),
  };
}

/** Вывод программы; не ноль — ошибка с её stderr. */
async function outputOf(
  program: string,
  args: readonly string[],
): Promise<string> {
  const done = await new Deno.Command(program, {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  if (done.code !== 0) {
    throw new Error(`${program}: ${decoder.decode(done.stderr).trim()}`);
  }
  return decoder.decode(done.stdout);
}

/**
 * Снимок настоящей машины: `/usr/bin/cat /proc/meminfo` и `/usr/bin/ps`.
 * Подпроцессами, а не чтением `/proc`: Deno пускает к `/proc` только с
 * `--allow-all` (замер 166a).
 */
export const SYSTEM_PROCS: ProcSource = {
  read: async () =>
    snapshotOf(
      await outputOf("/usr/bin/cat", ["/proc/meminfo"]),
      await outputOf("/usr/bin/ps", ["-e", "-o", "pid=,ppid=,rss=,comm="]),
    ),
};

/** Убийство `/usr/bin/kill -KILL`: `Deno.kill` чужого pid требует `--allow-run` без списка (замер 166a). */
async function killed(pid: number): Promise<void> {
  await outputOf("/usr/bin/kill", ["-KILL", String(pid)]);
}

/**
 * Руки сторожа: отметка в `dir` (десятичные МиБ и перевод строки) и
 * убийство.
 *
 * @param dir каталог отметок (`$XDG_RUNTIME_DIR/mpu/killed`)
 */
export function systemHands(dir: string): Hands {
  return {
    mark: async (pid, mib) => {
      await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(`${dir}/${pid}`, `${mib}\n`);
    },
    kill: killed,
  };
}

/**
 * Руки без каталога отметок (`XDG_RUNTIME_DIR` не задан): убить можно,
 * сказать ядру почему — негде; строка узнает «упал (сигнал 9)».
 */
export const MARKLESS_HANDS: Hands = {
  mark: () => Promise.resolve(),
  kill: killed,
};
