/**
 * Протокол получателя: описанные методы в порядке `about`, найденные у
 * экземпляра. Единственное место, где `about` встречается с прототипом.
 */

import type { Described } from "./about.ts";
import type { Keys } from "./answer.ts";
import type {
	MethodDescription,
	ReceiverDescription,
	SelectorGroups,
} from "./description.ts";
import { Shelf } from "./effect.ts";
import {
	type AboutData,
	type ClassData,
	DescribedMethod,
	type Method,
	NotUnderstood,
} from "./method.ts";

/** Описание класса без `about`: ничего не описано — ничего снаружи не достижимо. */
const NOTHING_DESCRIBED: AboutData = { comment: "", methods: {} };

/** Селекторы, которые описывать не нужно: `printString` — отражение. */
const UNDESCRIBED = new Set(["constructor", "printString"]);

/**
 * Функция `name` у `target` или по цепочке его прототипов до `Object`.
 * Дескриптором, а не чтением свойства: геттер не исполняется.
 */
// biome-ignore lint/complexity/noBannedTypes: метод домена зовётся `Reflect.apply`, сигнатуру знает только `about`
function methodOf(target: object, name: string): Function[] {
	for (
		let at: object | null = target;
		at !== null && at !== Object.prototype;
		at = Object.getPrototypeOf(at)
	) {
		const value = Object.getOwnPropertyDescriptor(at, name)?.value;
		if (typeof value === "function") return [value];
	}
	return [];
}

/** Собственные методы прототипа класса, которые должно описывать `about`. */
function ownMethods(prototype: object): string[] {
	return Object.getOwnPropertyNames(prototype).filter(
		(name) =>
			!UNDESCRIBED.has(name) &&
			typeof Object.getOwnPropertyDescriptor(prototype, name)?.value ===
				"function",
	);
}

/** Описанные методы экземпляра (или прототипа класса). */
export class Protocol {
	readonly #comment: string;
	readonly #methods: ReadonlyMap<string, DescribedMethod>;
	readonly #described: readonly string[];
	readonly #own: readonly string[];

	/** `receiver` — экземпляр класса `cls` или его прототип. */
	constructor(receiver: Described, cls: ClassData) {
		// Класс без `about` (поломка (г) в обход `tsc`) не понимает ничего.
		const about: AboutData = Reflect.get(cls, "about") ?? NOTHING_DESCRIBED;
		this.#comment = about.comment;
		this.#described = Object.keys(about.methods);
		this.#own = ownMethods(cls.prototype);
		this.#methods = new Map(
			Object.entries(about.methods).flatMap(([selector, method]) =>
				methodOf(receiver, selector).map((found) => {
					const invoke = (args: Keys): unknown =>
						Reflect.apply(found, receiver, [args]);
					return [selector, new DescribedMethod(selector, method, invoke)];
				}),
			),
		);
	}

	/** Протокол экземпляра класса-получателя. */
	static of(receiver: Described): Protocol {
		// `envelope` принимает экземпляр класса-получателя: статическое `about`
		// у его конструктора требует тип `ReceiverClass`, здесь он не виден.
		return new Protocol(receiver, receiver.constructor as unknown as ClassData);
	}

	/** Метод для селектора; не описан — `NotUnderstood`. */
	lookup(selector: string): Method {
		return (
			this.#methods.get(selector) ??
			new NotUnderstood(selector, [...this.#methods.keys()])
		);
	}

	respondsTo(selector: string): boolean {
		return this.#methods.has(selector);
	}

	selectors(): SelectorGroups {
		const shelf = new Shelf();
		for (const method of this.#methods.values()) method.file(shelf);
		return shelf.groups();
	}

	/** Собственные методы класса без описания. */
	undescribed(): string[] {
		return this.#own.filter((name) => !this.#described.includes(name));
	}

	/** Описания, для которых у получателя нет метода. */
	unimplemented(): string[] {
		return this.#described.filter((name) => !this.#methods.has(name));
	}

	/** Описанные методы с селектором — для проверок и графа. */
	methods(): DescribedMethod[] {
		return [...this.#methods.values()];
	}

	/** Страница каждого метода: описание и справка по пути `path`. */
	pages(path: readonly string[]): {
		readonly selector: string;
		readonly description: MethodDescription;
		readonly help: string;
	}[] {
		return [...this.#methods].map(([selector, method]) => ({
			selector,
			description: method.describe(),
			help: method.help(path),
		}));
	}

	describe(): ReceiverDescription {
		return {
			comment: this.#comment,
			methods: Object.fromEntries(
				[...this.#methods].map(([selector, method]) => [
					selector,
					method.describe(),
				]),
			),
		};
	}
}
