/**
 * Совместимость интерфейса (`[S.14ж]`): из прежнего `interface.json` не
 * пропадает метод и у метода не появляется обязательный ключ, если старый
 * путь не оставлен `deprecated` с заменой.
 */

import * as z from "zod";
import type { InterfaceFile } from "./interface.ts";

/** Что из файла интерфейса нужно сверке — прочее не читается. */
const Shape = z.object({
	receivers: z.record(
		z.string(),
		z.object({
			methods: z.record(
				z.string(),
				z.object({
					args: z.object({ required: z.array(z.string()).optional() }),
					deprecated: z.object({ use: z.string() }).nullable(),
				}),
			),
		}),
	),
});

/** Интерфейс в том виде, в каком его читает сверка. */
export type CompatShape = z.infer<typeof Shape>;
type Methods = CompatShape["receivers"][string]["methods"];

/**
 * Нарушения совместимости `current` против `previous`: по строке
 * `Класс.метод: что нарушено`; совместимо — пусто.
 */
export function breaches(
	previous: CompatShape,
	current: CompatShape,
): string[] {
	return Object.entries(previous.receivers).flatMap(([name, receiver]) =>
		// Получателя больше нет — пропали все его методы.
		methodBreaches(
			name,
			receiver.methods,
			current.receivers[name]?.methods ?? {},
		),
	);
}

function methodBreaches(
	name: string,
	before: Methods,
	after: Methods,
): string[] {
	return Object.entries(before).flatMap(([selector, old]) => {
		const now = after[selector];
		if (now === undefined) {
			const use = old.deprecated?.use ?? "";
			return Object.hasOwn(after, use)
				? []
				: [`${name}.${selector}: метод удалён без deprecated с заменой`];
		}
		const was = new Set(old.args.required ?? []);
		return (now.args.required ?? [])
			.filter((key) => !was.has(key))
			.map(
				(key) =>
					`${name}.${selector}: новый обязательный ключ ${key} — заведи новый метод, старый оставь deprecated с заменой`,
			);
	});
}

/** Прежний интерфейс, с которым сверяется новый. */
export interface Baseline {
	/** Нарушения для генератора: прежнего нет — сверять не с чем. */
	breaches(current: InterfaceFile): string[];
	/** Нарушения для проверки (ж): прежнего нет — сама находка. */
	audit(current: InterfaceFile): string[];
}

class Previous implements Baseline {
	readonly #shape: CompatShape;

	constructor(shape: CompatShape) {
		this.#shape = shape;
	}

	breaches(current: InterfaceFile): string[] {
		return breaches(this.#shape, Shape.parse(current));
	}

	audit(current: InterfaceFile): string[] {
		return this.breaches(current);
	}
}

/** Прежнего `interface.json` по пути `path` нет. */
export class MissingBaseline implements Baseline {
	readonly #path: string;

	constructor(path: string) {
		this.#path = path;
	}

	breaches(): string[] {
		return [];
	}

	audit(): string[] {
		return [
			`${this.#path}: нет прежнего interface.json — совместимость не проверена`,
		];
	}
}

/** Разобрать файл интерфейса; не той формы — ошибка `zod` с причиной. */
export function baseline(text: string): Baseline {
	return new Previous(Shape.parse(JSON.parse(text)));
}
