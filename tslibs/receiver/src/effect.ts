/**
 * Эффект метода объектом: правило, когда в книге его нет; полка отражения;
 * что значит для проверки (д) запись в фейк. `effect` автора — строка на
 * границе, превращается в объект один раз (`effectOf`).
 */

import type { Effect } from "./about.ts";
import type { SelectorGroups } from "./description.ts";
import { allow, ask, type Rule } from "./rules.ts";

/** Полка селекторов отражения: метод кладёт себя сам. */
export class Shelf {
	readonly #reading: string[] = [];
	readonly #writing: string[] = [];
	readonly #navigation: string[] = [];

	reading(selector: string): void {
		this.#reading.push(selector);
	}

	writing(selector: string): void {
		this.#writing.push(selector);
	}

	navigation(selector: string): void {
		this.#navigation.push(selector);
	}

	/** Селекторы по виду — копией. */
	groups(): SelectorGroups {
		return {
			reading: [...this.#reading],
			writing: [...this.#writing],
			navigation: [...this.#navigation],
		};
	}
}

/** Эффект метода. */
export interface EffectKind {
	readonly name: Effect;
	/** Правило, когда в книге для пути правила нет. */
	rule(): Rule;
	/** Положить метод с данными-результатом на свою полку. */
	file(shelf: Shelf, selector: string): void;
	/** Находки (д): метод `at` записал в фейк `wrote` раз. */
	audit(at: string, wrote: number): string[];
	/** Находки (д): у метода `at` нет примера. */
	unverified(at: string): string[];
}

const READ: EffectKind = {
	name: "read",
	rule: () => allow,
	file: (shelf, selector) => shelf.reading(selector),
	audit: (at, wrote) =>
		wrote === 0 ? [] : [`${at}: метод read записал в фейк ${wrote} раз`],
	unverified: (at) => [`${at}: метод read без примера — не проверен`],
};

function writing(name: Effect): EffectKind {
	return {
		name,
		rule: () => ask,
		file: (shelf, selector) => shelf.writing(selector),
		audit: () => [],
		unverified: () => [],
	};
}

const EFFECTS: Readonly<Record<Effect, EffectKind>> = {
	read: READ,
	write: writing("write"),
	send: writing("send"),
};

/** Эффект из описания; не задан — `read`. */
export function effectOf(effect: Effect = "read"): EffectKind {
	return EFFECTS[effect];
}
