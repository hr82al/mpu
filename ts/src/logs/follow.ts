/**
 * Слежение за новыми записями (`docs/specs/logs.md`, «CLI-контракт»):
 * начальная порция за окно `[since | now−10s .. now]`, дальше опрос
 * каждые две секунды окном `[последний_увиденный_ts + 1нс .. now]`.
 *
 * Курсор двигает только увиденная запись: пустой опрос оставляет его на
 * месте (окно растёт, пока источник молчит) — иначе терялись бы записи,
 * доезжающие в Loki с опозданием. Дублей это не даёт: направление
 * forward с лимитом дочитывает окно с того же конца.
 */

import { DomainError, formatCommandError } from "../command/mod.ts";
import type { LogEntry, RangeQuery } from "../loki/mod.ts";
import { lokiFailure } from "./failure.ts";
import { toNanoseconds } from "./query.ts";
import { byTimeAscending, formatEntries } from "./render.ts";
import type { LogStream } from "./sources.ts";

/** Пауза между опросами. */
const POLL_MS = 2_000;

/** Предел записей одного опроса; начальная порция берёт `--tail`. */
const POLL_LIMIT = 1_000;

/** Что и с какого момента слушать. */
export interface FollowPlan {
  readonly logql: string;
  /** Начало окна начальной порции, миллисекунды. */
  readonly startMs: number;
  /** Предел начальной порции — значение `--tail`. */
  readonly limit: number;
  readonly timestamps: boolean;
}

/** Чем слежение пользуется: источник, часы, пауза, вывод и остановка. */
export interface FollowDeps {
  readonly read: (query: RangeQuery) => Promise<readonly LogEntry[]>;
  readonly now: () => number;
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly stream: LogStream;
  /** Остановка: на CLI её взводит Ctrl+C. */
  readonly signal: AbortSignal;
}

/**
 * Слушает, пока не сработает сигнал остановки. Отказ начального запроса
 * — отказ всего вызова; отказ опроса печатается в stderr с ведущим
 * переводом строки, и слежение продолжается с тем же курсором.
 */
export async function followEntries(
  deps: FollowDeps,
  plan: FollowPlan,
): Promise<void> {
  const startNs = toNanoseconds(plan.startMs);
  let lastSeenNs: bigint | undefined;

  try {
    lastSeenNs = await poll(deps, plan, startNs, plan.limit);
  } catch (err) {
    throw lokiFailure(err, plan.logql);
  }

  while (!deps.signal.aborted) {
    await deps.wait(POLL_MS, deps.signal);
    if (deps.signal.aborted) break;
    const from = lastSeenNs === undefined ? startNs : lastSeenNs + 1n;
    try {
      lastSeenNs = await poll(deps, plan, from, POLL_LIMIT) ?? lastSeenNs;
    } catch (err) {
      const failure = lokiFailure(err, plan.logql);
      if (!(failure instanceof DomainError)) throw failure;
      deps.stream.err(`\n${formatCommandError(["logs"], failure)}\n`);
    }
  }
}

/**
 * Один запрос окна `[from .. now]` вперёд: печатает записи по
 * возрастанию времени и отвечает временем последней из них. Записей нет
 * — `undefined`, и курсор остаётся прежним.
 */
async function poll(
  deps: FollowDeps,
  plan: FollowPlan,
  from: bigint,
  limit: number,
): Promise<bigint | undefined> {
  const entries = byTimeAscending(
    await deps.read({
      logql: plan.logql,
      startNs: from,
      endNs: toNanoseconds(deps.now()),
      limit,
      direction: "forward",
    }),
  );
  if (entries.length === 0) return undefined;
  deps.stream.out(formatEntries(entries, plan.timestamps));
  return BigInt(entries[entries.length - 1].tsNs);
}
