/**
 * Отказы конверта. Каждый вид — своя функция с постоянной `reason`; текст
 * и подсказка выводятся из тех же полей, что объект.
 */

import type { Answer, Listener, RefusalData } from "./answer.ts";
import { nearest } from "./nearest.ts";

/** Отказ — ответ конверта. */
export class Refusal implements Answer {
	readonly #data: RefusalData;

	constructor(data: RefusalData) {
		this.#data = data;
	}

	tell<R>(to: Listener<R>): R {
		return to.refusal(structuredClone(this.#data));
	}

	/** Текст отказа для человека. */
	text(): string {
		return this.#data.text;
	}
}

function plain(reason: string, text: string): Refusal {
	return new Refusal({ reason, hint: null, candidates: [], text });
}

/**
 * Слово `word` не понял получатель по пути `path`, который понимает
 * `known`. Одна ближайшая — подсказка: путь с ней.
 */
export function notUnderstood(
	path: readonly string[],
	word: string,
	known: readonly string[],
): Refusal {
	const near = nearest(word, known);
	return new Refusal({
		reason: "непонятно",
		hint: near.length === 1 ? [...path, ...near] : null,
		candidates: near,
		text: `${path.join(" ")} не понимает ${word}${closest(near)}; понимаю: ${known.join(", ")}`,
	});
}

/** Ключ `key` не описан у метода по пути `path`. */
export function unknownKey(
	path: string,
	key: string,
	known: readonly string[],
): Refusal {
	const near = nearest(key, known);
	return new Refusal({
		reason: "непонятно",
		hint: null,
		candidates: near,
		text: `${path} не понимает ключ ${key}${closest(near)}; понимаю: ${known.join(", ")}`,
	});
}

function closest(near: readonly string[]): string {
	return near.length === 0 ? "" : ` — ближе всего: ${near.join(", ")}`;
}

/** Обязательного ключа нет; `usage` — строка вызова с местами ключей. */
export function missingKey(path: string, key: string, usage: string): Refusal {
	return plain(
		"не хватает ключа",
		`${path}: не хватает ключа ${key} — пиши: ${path} ${usage}`,
	);
}

/** Значение ключа не того вида; `came` — как значение показано. */
export function wrongKey(
	path: string,
	key: string,
	expected: string,
	came: string,
): Refusal {
	return plain(
		"неверный ключ",
		`${path}: ключ ${key} — ожидается ${expected}, пришло ${came}`,
	);
}

/** Ключи не прошли уточнение схемы целиком; `message` — от автора схемы. */
export function invalidKeys(path: string, message: string): Refusal {
	return plain("неверные ключи", `${path}: неверные ключи — ${message}`);
}

/** Правило запретило. */
export function denied(path: string): Refusal {
	return plain(
		"запрещено правилом",
		`${path}: запрещено правилом — изменить правила может только человек (mpu policy)`,
	);
}

/** Человек ответил «нет». */
export function declined(path: string): Refusal {
	return plain(
		"не подтверждено",
		`${path}: человек ответил «нет» — строка не исполнена`,
	);
}

/** Сигнал прерван до начала вызова. */
export function cancelled(path: string): Refusal {
	return plain("отменено", `${path}: отменено`);
}
