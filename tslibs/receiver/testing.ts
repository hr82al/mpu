/**
 * `@mpu/receiver/testing` — тесты соответствия домена, фейки портов
 * конверта и чтение ответа данными.
 */

import { describe, expect, it } from "vitest";
import type { Described } from "./src/about.ts";
import type { Answer, Enveloped, RefusalData } from "./src/answer.ts";
import { CHECKS, type Fakes, type Subject } from "./src/conformance.ts";
import type { Clock, Journal, JournalEntry } from "./src/context.ts";
import type { Asker, Reply, Rule, RuleBook } from "./src/rules.ts";
import { inherited } from "./src/rules.ts";

export type { Fakes, Subject } from "./src/conformance.ts";

/** Журнал в памяти. */
export class MemoryJournal implements Journal {
	readonly #entries: JournalEntry[] = [];

	async write(entry: JournalEntry): Promise<void> {
		this.#entries.push(structuredClone(entry));
	}

	/** Записи по порядку — копией. */
	entries(): JournalEntry[] {
		return structuredClone(this.#entries);
	}
}

/** Спрашивающий, который всегда отвечает одно и помнит вопросы. */
export class Asking implements Asker {
	readonly #reply: Reply;
	readonly #questions: string[] = [];

	constructor(reply: Reply) {
		this.#reply = reply;
	}

	async ask(question: string): Promise<Reply> {
		this.#questions.push(question);
		return this.#reply;
	}

	/** Заданные вопросы по порядку — копией. */
	questions(): string[] {
		return [...this.#questions];
	}
}

/** Спрашивающий, отвечающий всегда `reply` (`agreed` или `refused`). */
export function asking(reply: Reply): Asking {
	return new Asking(reply);
}

/** Книга правил из таблицы «путь → решение»; пути нет — `inherited`. */
export function rulesOf(table: Readonly<Record<string, Rule>>): RuleBook {
	const rules = new Map(Object.entries(table));
	return { rule: (path) => rules.get(path) ?? inherited };
}

/** Часы, которые при каждом чтении уходят вперёд на `step` мс от нуля. */
export function steppingClock(step: number): Clock {
	let now = -step;
	return {
		now: () => {
			now += step;
			return now;
		},
	};
}

/** Ответ данными: значение, получатель (его `printString`) или отказ. */
export type Told =
	| { readonly value: unknown }
	| { readonly receiver: string }
	| { readonly refusal: RefusalData };

/** Прочитать ответ данными — для сравнения в тесте. */
export function outcome(answer: Answer): Told {
	return answer.tell<Told>({
		value: (value) => ({ value }),
		receiver: (receiver) => ({ receiver: receiver.printString() }),
		refusal: (refusal) => ({ refusal }),
	});
}

/** Получатель из ответа навигации; другой ответ — ошибка теста. */
export function navigated(answer: Answer): Enveloped<unknown> {
	return answer.tell<Enveloped<unknown>>({
		value: (value) => {
			throw new Error(
				`ждали получатель, пришло значение ${JSON.stringify(value)}`,
			);
		},
		receiver: (receiver) => receiver,
		refusal: (refusal) => {
			throw new Error(`ждали получатель, пришёл отказ: ${refusal.text}`);
		},
	});
}

/**
 * Тесты соответствия домена одной строкой в его тесте:
 * `conformance({ root: Kaiten, path: ["kaiten"], fakes, create, dir })`.
 * Каждая проверка — свой случай; падение печатает находки.
 */
export function conformance<T extends Described, F extends Fakes>(
	subject: Subject<T, F>,
): void {
	describe(`соответствие ${subject.root.name}`, () => {
		for (const check of CHECKS) {
			it(check.name, async () => {
				expect(await check.findings(subject), check.name).toStrictEqual([]);
			});
		}
	});
}
