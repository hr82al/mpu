/**
 * Ключи метода: проверка объекта ключей схемой `args`, вид ключа словами,
 * маска секрета. Схема — единственный источник: справка, отказ, журнал и
 * файл интерфейса берут ключи отсюда.
 */

import { inspect } from "node:util";
import * as z from "zod";
import type { Answer, Keys as Given } from "./answer.ts";
import type { ArgsSchema } from "./description.ts";
import {
	invalidKeys,
	missingKey,
	type Refusal,
	unknownKey,
	wrongKey,
} from "./refusal.ts";

const MASK = "***";

/** Проверенные ключи: продолжить вызов или ответить отказом. */
export interface Checked {
	proceed(next: (args: Given) => Promise<Answer>): Promise<Answer>;
}

class Valid implements Checked {
	readonly #args: Given;

	constructor(args: Given) {
		this.#args = args;
	}

	proceed(next: (args: Given) => Promise<Answer>): Promise<Answer> {
		return next(this.#args);
	}
}

class Invalid implements Checked {
	readonly #refusal: Refusal;

	constructor(refusal: Refusal) {
		this.#refusal = refusal;
	}

	async proceed(): Promise<Answer> {
		return this.#refusal;
	}
}

/**
 * Значение словами — тотально: `JSON.stringify` бросает на `BigInt` и
 * цикле, а отказ «неверный ключ» не должен становиться исключением.
 */
function shown(value: unknown): string {
	return inspect(value, { breakLength: Number.POSITIVE_INFINITY, depth: 4 });
}

/** Как ключ показывает своё значение: в строке, в отказе, в журнале. */
interface Display {
	/** Значение словом строки вызова (`text: ок`). */
	word(value: unknown): string;
	/** Значение в отказе: как пришло. */
	came(value: unknown): string;
	/** Значение для журнала. */
	logged(value: unknown): unknown;
}

/** Строка без пробелов — как есть, с пробелами — в кавычках, прочее — `shown`. */
function word(value: unknown): string {
	if (typeof value !== "string") return shown(value);
	return /\s/.test(value) ? JSON.stringify(value) : value;
}

const PLAIN: Display = { word, came: shown, logged: (value) => value };

const SECRET: Display = {
	word: () => MASK,
	came: () => MASK,
	logged: () => MASK,
};

/** Нужен ли ключ: словом справки и местом в строке вызова. */
interface Need {
	readonly word: string;
	/** Место ключа в строке вызова, если без него не обойтись. */
	usage(place: string): string[];
}

const REQUIRED: Need = { word: "обязательный", usage: (place) => [place] };
const OPTIONAL: Need = { word: "необязательный", usage: () => [] };

interface JsonProperty {
	readonly type?: string;
	readonly enum?: readonly unknown[];
	readonly description?: string;
}

interface JsonObject {
	readonly properties: Readonly<Record<string, JsonProperty>>;
	readonly required?: readonly string[];
}

/** Вид ключа словами — из JSON-схемы, данных границы. */
function kindOf(property: JsonProperty): string {
	if (property.enum !== undefined)
		return `одно из: ${property.enum.join(", ")}`;
	switch (property.type) {
		case "string":
			return "строка";
		case "integer":
			return "целое";
		case "number":
			return "число";
		case "boolean":
			return "да/нет";
		case "array":
			return "список";
		case "object":
			return "объект";
		default:
			return "значение";
	}
}

/** Один ключ: имя, вид словами, нужность и показ значения. */
class Key {
	readonly name: string;
	readonly #kind: string;
	readonly #need: Need;
	readonly #display: Display;
	readonly #purpose: string;

	constructor(
		name: string,
		property: JsonProperty,
		need: Need,
		display: Display,
	) {
		this.name = name;
		this.#kind = kindOf(property);
		this.#need = need;
		this.#display = display;
		this.#purpose = property.description ?? "";
	}

	/** Строка справки: `text — строка, обязательный — текст комментария`. */
	line(): string {
		const purpose = this.#purpose === "" ? "" : ` — ${this.#purpose}`;
		return `${this.name} — ${this.#kind}, ${this.#need.word}${purpose}`;
	}

	/** Место в строке вызова (`text: <строка>`), если ключ обязателен. */
	usage(): string[] {
		return this.#need.usage(`${this.name}: <${this.#kind}>`);
	}

	/**
	 * Отказ на значение ключа у метода по пути `path`; ключа нет вовсе —
	 * «не хватает», с обязательными ключами `usage` строки вызова.
	 */
	wrong(path: string, value: unknown, usage: string): Refusal {
		if (value === undefined) return missingKey(path, this.name, usage);
		return wrongKey(path, this.name, this.#kind, this.#display.came(value));
	}

	/** Ключ словами строки вызова: `text: ок`. */
	word(value: unknown): string {
		return `${this.name}: ${this.#display.word(value)}`;
	}

	logged(value: unknown): unknown {
		return this.#display.logged(value);
	}
}

/** Ключи одного метода. */
export class KeySet {
	readonly #schema: z.ZodObject;
	readonly #json: ArgsSchema;
	readonly #keys: ReadonlyMap<string, Key>;
	readonly #secret: readonly string[];

	/** Без схемы — метод без ключей: пустая строгая схема. */
	constructor(
		schema: z.ZodObject = z.object({}),
		secret: readonly string[] = [],
	) {
		this.#schema = schema.strict();
		this.#secret = [...secret];
		// Описывается вход: ключ с `default` не обязателен. Непредставимый вид
		// (`transform`, `date`) — пустая схема ключа, «значение» в справке.
		const { $schema: _, ...json } = z.toJSONSchema(this.#schema, {
			io: "input",
			unrepresentable: "any",
		});
		this.#json = json;
		// `toJSONSchema` строгого объекта всегда даёт `properties`: форма данных
		// границы, проверенная тестом описания.
		const object = json as unknown as JsonObject;
		const required = new Set(object.required ?? []);
		this.#keys = new Map(
			Object.entries(object.properties).map(([name, property]) => {
				const need = required.has(name) ? REQUIRED : OPTIONAL;
				const display = secret.includes(name) ? SECRET : PLAIN;
				return [name, new Key(name, property, need, display)];
			}),
		);
	}

	/** Проверить ключи для метода по пути `path`. */
	check(path: string, args: Given): Checked {
		const parsed = this.#schema.safeParse(args);
		if (parsed.success) return new Valid(parsed.data);
		return new Invalid(this.#refusal(path, args, parsed.error.issues));
	}

	/**
	 * Отказ по первой ошибке разбора; неизвестный ключ — раньше прочих:
	 * опечатка в имени иначе выглядела бы нехваткой ключа. Ошибка не по
	 * ключу (уточнение схемы целиком) — отказ с сообщением автора схемы.
	 */
	#refusal(
		path: string,
		args: Given,
		issues: readonly z.core.$ZodIssue[],
	): Refusal {
		const names = [...this.#keys.keys()];
		const unknown = issues.find((issue) => issue.code === "unrecognized_keys");
		if (unknown !== undefined) {
			return unknownKey(path, unknown.keys[0] ?? "", names);
		}
		const first = issues[0];
		const key = this.#keys.get(String(first?.path[0] ?? ""));
		if (key === undefined) return invalidKeys(path, first?.message ?? "");
		return key.wrong(path, args[key.name], this.usage());
	}

	/** Обязательные ключи местами строки вызова: `text: <строка>`. */
	usage(): string {
		return this.#all()
			.flatMap((key) => key.usage())
			.join(" ");
	}

	/** Ключи словами строки вызова, секреты замаскированы. */
	words(args: Given): string {
		return this.#present(args)
			.map(([key, value]) => key.word(value))
			.join(" ");
	}

	/** Ключи для журнала, секреты замаскированы. */
	logged(args: Given): Given {
		return Object.fromEntries(
			this.#present(args).map(([key, value]) => [key.name, key.logged(value)]),
		);
	}

	/** Строки справки по ключу. */
	lines(): string[] {
		return this.#all().map((key) => key.line());
	}

	/** Имена ключей-секретов. */
	secret(): string[] {
		return [...this.#secret];
	}

	/** JSON-схема ключей — копией. */
	json(): ArgsSchema {
		return structuredClone(this.#json);
	}

	#all(): Key[] {
		return [...this.#keys.values()];
	}

	#present(args: Given): [Key, unknown][] {
		return this.#all()
			.filter((key) => args[key.name] !== undefined)
			.map((key) => [key, args[key.name]]);
	}
}
