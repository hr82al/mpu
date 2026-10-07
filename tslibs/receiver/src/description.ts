/**
 * Описание получателя данными — граница контракта: его отдают `describe()`
 * отражения и файл интерфейса `interface.json`.
 */

import type { Effect } from "./about.ts";

/** JSON-схема ключей метода (`z.toJSONSchema` без `$schema`). */
export type ArgsSchema = Readonly<Record<string, unknown>>;

/** Пример метода данными: ключи и ответ. */
export interface ExampleDescription {
	readonly args?: Readonly<Record<string, unknown>>;
	readonly answer: unknown;
}

/** Метод данными. */
export interface MethodDescription {
	readonly comment: string;
	readonly effect: Effect;
	/** `"data"` или имя класса-получателя. */
	readonly returns: string;
	readonly args: ArgsSchema;
	readonly secret: readonly string[];
	readonly raises: readonly string[];
	/** Не устарел — `null`. */
	readonly deprecated: { readonly use: string; readonly since: string } | null;
	readonly examples: readonly ExampleDescription[];
}

/** Получатель данными: что он такое и его методы в порядке объявления. */
export interface ReceiverDescription {
	readonly comment: string;
	readonly methods: Readonly<Record<string, MethodDescription>>;
}

/** Ответ `describe()`: описание и путь, по которому получатель достигнут. */
export interface Description extends ReceiverDescription {
	readonly path: string;
}

/** Селекторы по виду: читающие, пишущие (и отправляющие), навигация. */
export interface SelectorGroups {
	readonly reading: readonly string[];
	readonly writing: readonly string[];
	readonly navigation: readonly string[];
}
