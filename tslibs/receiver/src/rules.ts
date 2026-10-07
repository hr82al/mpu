/**
 * Книга правил и её решения: `allow`, `ask`, `deny` и `inherited` — правила
 * нет, решает `effect` метода. Решение само выбирает, что сделать с вызовом;
 * у конверта ветки по виду правила нет.
 */

import type { Answer } from "./answer.ts";

/** Вызов, ждущий решения: что решение может с ним сделать. */
export interface Admission {
	/** Исполнить. */
	perform(): Promise<Answer>;
	/** Отказать: запрещено правилом. */
	deny(): Promise<Answer>;
	/** Спросить человека. */
	ask(): Promise<Answer>;
	/** Отказать: человек ответил «нет». */
	decline(): Promise<Answer>;
	/** Решить правилом по умолчанию метода (из `effect`). */
	inherit(): Promise<Answer>;
}

/** Решение книги для пути. */
export interface Rule {
	admit(admission: Admission): Promise<Answer>;
}

/** Исполнять без вопроса. */
export const allow: Rule = { admit: (admission) => admission.perform() };

/** Спросить человека. */
export const ask: Rule = { admit: (admission) => admission.ask() };

/** Не исполнять. */
export const deny: Rule = { admit: (admission) => admission.deny() };

/** Правила для пути нет: решает `effect` метода. */
export const inherited: Rule = { admit: (admission) => admission.inherit() };

/** Порт книги правил: путь (`kaiten card comment`) → решение. */
export interface RuleBook {
	/** Правила для пути нет — `inherited`. */
	rule(path: string): Rule;
}

/** Что ответ человека может сделать с вызовом. */
export interface Followed {
	perform(): Promise<Answer>;
	decline(): Promise<Answer>;
}

/** Ответ человека: сам выбирает, что сделать с вызовом. Конверт зовёт `follow` один раз. */
export interface Reply {
	follow(call: Followed): Promise<Answer>;
}

/** Человек ответил «да». */
export const agreed: Reply = { follow: (call) => call.perform() };

/** Человек ответил «нет». */
export const refused: Reply = { follow: (call) => call.decline() };

/** Порт спрашивающего: вопрос человеку → его ответ (`agreed`/`refused`). */
export interface Asker {
	ask(
		question: string,
		options: { readonly signal: AbortSignal },
	): Promise<Reply>;
}
