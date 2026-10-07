/**
 * Ответ конверта на сообщение: значение, получатель или отказ. Кто
 * спрашивает, тот и решает, что с каждым делать, — `tell` зовёт ровно один
 * метод слушателя.
 */

import type { Selectors } from "./about.ts";
import type { Description, SelectorGroups } from "./description.ts";

/** Объект отказа (`platform/refusal-object.md`) — граница контракта. */
export interface RefusalData {
	/** Вид отказа — постоянная строка без значений. */
	readonly reason: string;
	/** Исправленная строка словами; подсказать нечего — `null`. */
	readonly hint: readonly string[] | null;
	/** Ближайшие селекторы или ключи; нет — пусто. */
	readonly candidates: readonly string[];
	/** Текст отказа для человека. */
	readonly text: string;
}

/** Ключи сообщения — один объект. */
export type Keys = Readonly<Record<string, unknown>>;

/** Получатель в конверте: снаружи достижимо только описанное. */
export interface Enveloped<T> {
	/**
	 * Послать сообщение: селектор и объект ключей. Непонятое, неверные ключи,
	 * запрет и отмена — отказ в ответе, не исключение; сбой самого метода —
	 * исключение.
	 */
	send(selector: Selectors<T> | (string & {}), args?: Keys): Promise<Answer>;
	/** Описание получателя и путь. */
	describe(): Description;
	/** Описанные селекторы по виду. */
	selectors(): SelectorGroups;
	/** Понимает ли получатель селектор. */
	respondsTo(selector: string): boolean;
	/** Справка метода; непонятный селектор — текст отказа «непонятно». */
	help(selector: string): string;
	/** Имя экземпляра для человека. */
	printString(): string;
}

/** Слушатель ответа: ровно один метод будет вызван. */
export interface Listener<R> {
	value(data: unknown): R;
	receiver(receiver: Enveloped<unknown>): R;
	refusal(data: RefusalData): R;
}

/** Ответ конверта. */
export interface Answer {
	tell<R>(to: Listener<R>): R;
}

/** Ответ-данные метода. */
export class Value implements Answer {
	readonly #data: unknown;

	constructor(data: unknown) {
		this.#data = data;
	}

	tell<R>(to: Listener<R>): R {
		return to.value(this.#data);
	}
}

/** Ответ-получатель: результат навигации в том же конверте. */
export class Navigated implements Answer {
	readonly #receiver: Enveloped<unknown>;

	constructor(receiver: Enveloped<unknown>) {
		this.#receiver = receiver;
	}

	tell<R>(to: Listener<R>): R {
		return to.receiver(this.#receiver);
	}
}
