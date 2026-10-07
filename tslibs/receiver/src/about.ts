/**
 * Описание получателя данными рядом с методами: `about` класса. Из него одного
 * выводятся проверка ключей, правило по умолчанию, справка, файл интерфейса и
 * тесты соответствия.
 */

import type * as z from "zod";

/** Что умеет каждый получатель сам: назвать себя человеку. */
export interface Described {
	/** Имя экземпляра для человека (`Card 123`). */
	printString(): string;
}

/** Что делает метод снаружи: читает, пишет или отправляет. */
export type Effect = "read" | "write" | "send";

// biome-ignore lint/suspicious/noExplicitAny: параметр любого метода — сужение ниже по типу
type Method = (...args: any[]) => unknown;

/** Публичные методы `T`, которые описывает `about` (без `printString`). */
export type Selectors<T> = {
	[K in keyof T]: T[K] extends Method
		? K extends keyof Described
			? never
			: K
		: never;
}[keyof T] &
	string;

/** Класс-получатель: его экземпляры — `T`, статическое `about` — описание. */
export interface ReceiverClass<T> {
	readonly about: About<T>;
	readonly name: string;
	readonly prototype: T;
}

/** Метод устарел: зови `use`, начиная с версии `since`. */
export interface Deprecated<T> {
	readonly use: Selectors<T>;
	readonly since: string;
}

type Result<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

/** Пример: вызов и ответ; ответ навигации — `printString` получателя. */
export type Example<A, R> = (R extends Described
	? { readonly answer: string }
	: { readonly answer: R }) &
	([A] extends [never] ? { readonly args?: undefined } : { readonly args: A });

type ReturnsPart<R> = R extends Described
	? { readonly returns: ReceiverClass<R> }
	: { readonly returns?: "data" };

type ArgsPart<F> = F extends () => unknown
	? {
			readonly args?: undefined;
			readonly examples?: readonly Example<never, Result<F>>[];
		}
	: F extends (args: infer A) => unknown
		? {
				readonly args: z.ZodObject;
				readonly secret?: readonly (keyof A & string)[];
				readonly examples?: readonly Example<A, Result<F>>[];
			}
		: never;

/** Описание одного метода `F` получателя `T`. */
export type MethodAbout<T, F> = {
	/** Первая строка — что делает; следующие — когда звать (обе обязательны). */
	readonly comment: `${string}\n${string}`;
	/** По умолчанию `read`. */
	readonly effect?: Effect;
	/** Ошибки, которые метод бросает, — по строке на каждую. */
	readonly raises?: readonly string[];
	readonly deprecated?: Deprecated<T>;
} & ArgsPart<F> &
	ReturnsPart<Result<F>>;

/** Описания методов `T`: ключи — ровно `Selectors<T>`. */
export type Methods<T> = {
	readonly [K in Selectors<T>]: MethodAbout<T, T[K]>;
};

/** Описание получателя `T`: что он такое и его методы. */
export interface About<T> {
	readonly comment: string;
	readonly methods: Methods<T>;
}

type ArgsOf<F> = F extends (args: infer A) => unknown ? A : never;
type Same<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;

/**
 * Литерал описаний `M`, в котором несовпадение помечено: лишний метод — тип
 * `"описание без метода"`, схема не равна параметру — кортеж с ожидаемым
 * типом. Присваивание `ZodObject` само этого не ловит: по форме он
 * ковариантен, и схема с лишним ключом присваивается.
 */
type Checked<T, M> = {
	[K in keyof M]: K extends Selectors<T>
		? M[K] extends { readonly args: infer S extends z.ZodObject }
			? Same<z.output<S>, ArgsOf<T[K]>> extends true
				? M[K]
				: { readonly args: ["схема не равна параметру метода", ArgsOf<T[K]>] }
			: M[K]
		: "описание без метода";
};

/**
 * Проверить описание `T` точно: `described<Card>()({ comment, methods })`.
 * Сверх `About<T>` ловит схему `args`, чей `z.infer` не равен параметру
 * метода, и описание метода, которого у `T` нет.
 */
export function described<T>() {
	return <const M extends Methods<T>>(about: {
		readonly comment: string;
		readonly methods: M & Checked<T, M>;
	}): About<T> => about;
}
