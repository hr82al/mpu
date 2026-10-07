/**
 * Порты конверта, кроме правил: журнал и часы, и контекст целиком —
 * всё внешнее приходит в конверт ссылкой.
 */

import type { Keys } from "./answer.ts";
import type { Asker, RuleBook } from "./rules.ts";

/** Исход допущенного к решению вызова. */
export type Outcome = "ok" | "denied" | "declined" | "error";

/** Запись журнала: путь, ключи (секреты — `***`), исход, длительность. */
export interface JournalEntry {
	readonly path: string;
	readonly args: Keys;
	readonly outcome: Outcome;
	readonly ms: number;
}

/** Порт журнала. */
export interface Journal {
	write(entry: JournalEntry): Promise<void>;
}

/** Порт часов: миллисекунды от любой постоянной точки. */
export interface Clock {
	now(): number;
}

/** Контекст конверта. */
export interface Context {
	/** Путь до получателя словами (`["kaiten", "card"]`). */
	readonly path: readonly string[];
	readonly rules: RuleBook;
	readonly journal: Journal;
	readonly asker: Asker;
	readonly clock: Clock;
	/** Прерван — вызовы не начинаются. */
	readonly signal: AbortSignal;
}
