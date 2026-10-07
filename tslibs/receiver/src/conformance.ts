/**
 * Проверки соответствия домена своему описанию ([S.14] (а)–(ж)). Каждая
 * отвечает списком находок; пусто — домен соответствует. Vitest здесь не
 * нужен: обёртку `conformance` даёт `testing.ts`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Described } from "./about.ts";
import type { Enveloped } from "./answer.ts";
import { envelope } from "./envelope.ts";
import { Graph, type Node, type Root, type Step } from "./graph.ts";
import { interfaceJson, interfaceOf } from "./interface.ts";
import type { DescribedMethod, ExampleData } from "./method.ts";
import { allow, refused } from "./rules.ts";
import { previousInterface } from "./write.ts";

/** Фейки домена: сколько записей в них сделано — монотонно. */
export interface Fakes {
	writes(): number;
}

/**
 * Домен под проверкой: корень, его путь, свежие фейки, экземпляр корня на
 * них и каталог с `interface.json` и `INTERFACE.md`.
 */
export interface Subject<T extends Described, F extends Fakes = Fakes>
	extends Root<T> {
	/** Новые фейки: каждый пример исполняется на чистых. */
	fakes(): F;
	/** Корень на фейках. */
	create(fakes: F): T;
	readonly dir: string;
}

/** Проверка соответствия. */
export interface Check {
	readonly name: string;
	findings<T extends Described, F extends Fakes>(
		subject: Subject<T, F>,
	): Promise<string[]>;
}

function nodes<T extends Described, F extends Fakes>(
	subject: Subject<T, F>,
): Node[] {
	return Graph.of(subject).nodes();
}

/** (а) Публичный метод без описания. */
export const undescribed: Check = {
	name: "(а) у каждого метода есть описание",
	findings: async (subject) =>
		nodes(subject).flatMap((node) => node.undescribed()),
};

/** (б) Описание без метода. */
export const unimplemented: Check = {
	name: "(б) у каждого описания есть метод",
	findings: async (subject) =>
		nodes(subject).flatMap((node) => node.unimplemented()),
};

/** (г) `returns` — класс без `about`. */
export const returnsDescribed: Check = {
	name: "(г) returns — описанный класс",
	findings: async (subject) => nodes(subject).flatMap((node) => node.bare()),
};

/** Исход одного примера: находки (в) и (д). */
interface Run {
	readonly wrong: readonly string[];
	readonly impure: readonly string[];
}

/** Где кончился путь по примерам навигации. */
interface Arrival {
	step(step: Step): Promise<Arrival>;
	run(
		at: string,
		method: DescribedMethod,
		example: ExampleData,
		fakes: Fakes,
	): Promise<Run>;
}

class Stranded implements Arrival {
	readonly #reason: string;

	constructor(reason: string) {
		this.#reason = reason;
	}

	async step(): Promise<Arrival> {
		return this;
	}

	async run(at: string): Promise<Run> {
		return {
			wrong: [`${at}: пример не исполнен — ${this.#reason}`],
			impure: [],
		};
	}
}

/** Ответ словами сверки с `answer` примера. */
function told(
	receiver: Enveloped<unknown>,
	selector: string,
	args: ExampleData["args"],
) {
	return receiver.send(selector, args ?? {}).then((answer) =>
		answer.tell<unknown>({
			value: (value) => value,
			receiver: (found) => found.printString(),
			refusal: (refusal) => `отказ: ${refusal.text}`,
		}),
	);
}

class Arrived implements Arrival {
	readonly #receiver: Enveloped<unknown>;

	constructor(receiver: Enveloped<unknown>) {
		this.#receiver = receiver;
	}

	async step(step: Step): Promise<Arrival> {
		const [example] = step.method.examples();
		if (example === undefined) {
			return new Stranded(`у навигации ${step.selector} нет примера`);
		}
		try {
			const answer = await this.#receiver.send(
				step.selector,
				example.args ?? {},
			);
			return answer.tell<Arrival>({
				value: () =>
					new Stranded(`навигация ${step.selector} ответила данными`),
				receiver: (found) => new Arrived(found),
				refusal: (refusal) => new Stranded(`отказ: ${refusal.text}`),
			});
		} catch (error) {
			return new Stranded(
				`навигация ${step.selector} бросила: ${String(error)}`,
			);
		}
	}

	async run(
		at: string,
		method: DescribedMethod,
		example: ExampleData,
		fakes: Fakes,
	): Promise<Run> {
		const before = fakes.writes();
		try {
			const got = await told(this.#receiver, method.selector, example.args);
			const wrong = isDeepStrictEqual(got, example.answer)
				? []
				: [
						`${at}: пример ждёт ${JSON.stringify(example.answer)}, пришло ${JSON.stringify(got)}`,
					];
			return { wrong, impure: method.audit(at, fakes.writes() - before) };
		} catch (error) {
			const wrong = [`${at}: пример бросил: ${String(error)}`];
			return { wrong, impure: method.audit(at, fakes.writes() - before) };
		}
	}
}

/** Книга примеров разрешает всё: спрашивать некого и незачем. */
function enveloped(receiver: Described, path: readonly string[]) {
	return envelope(receiver, {
		path,
		rules: { rule: () => allow },
		journal: { write: async () => {} },
		asker: { ask: async () => refused },
		clock: { now: () => 0 },
		signal: new AbortController().signal,
	});
}

/** Исполнить пример на свежих фейках, пройдя к классу маршрутом от корня. */
async function exercise<T extends Described, F extends Fakes>(
	subject: Subject<T, F>,
	node: Node,
	method: DescribedMethod,
	example: ExampleData,
): Promise<Run> {
	const fakes = subject.fakes();
	let arrival: Arrival = new Arrived(
		enveloped(subject.create(fakes), subject.path),
	);
	for (const step of node.route) arrival = await arrival.step(step);
	return arrival.run(`${node.name}.${method.selector}`, method, example, fakes);
}

/** Каждый пример каждого метода графа. */
async function runs<T extends Described, F extends Fakes>(
	subject: Subject<T, F>,
): Promise<Run[]> {
	const done: Run[] = [];
	for (const node of nodes(subject)) {
		for (const method of node.methods()) {
			for (const example of method.examples()) {
				done.push(await exercise(subject, node, method, example));
			}
		}
	}
	return done;
}

/** (в) Пример с неверным ответом или неисполнимый. */
export const examples: Check = {
	name: "(в) примеры исполнимы и верны",
	findings: async (subject) =>
		(await runs(subject)).flatMap((run) => run.wrong),
};

/** (д) Метод `read`, который пишет в фейк, или без примера. */
export const readIsPure: Check = {
	name: "(д) читающие методы не пишут",
	async findings(subject) {
		const untested = nodes(subject).flatMap((node) =>
			node
				.methods()
				.flatMap((method) =>
					method.unverified(`${node.name}.${method.selector}`),
				),
		);
		return [...untested, ...(await runs(subject)).flatMap((run) => run.impure)];
	},
};

/** (е) `interface.json` на диске не равен сгенерированному. */
export const interfaceCurrent: Check = {
	name: "(е) interface.json совпадает с about",
	async findings(subject) {
		const path = join(subject.dir, "interface.json");
		const expected = interfaceJson(subject);
		// Нечитаемый файл — та же находка: на диске нет того, что даёт `about`;
		// причина чтения идёт в текст находки.
		return readFile(path, "utf8").then(
			(disk) =>
				disk === expected
					? []
					: [`${path}: не совпадает с about — запусти bun run interface`],
			(error: unknown) => [
				`${path}: не прочитан (${String(error)}) — запусти bun run interface`,
			],
		);
	},
};

/** (ж) Удалён метод или добавлен обязательный ключ без `deprecated` с заменой. */
export const interfaceCompatible: Check = {
	name: "(ж) интерфейс совместим с прежним",
	async findings(subject) {
		return (await previousInterface(subject.dir)).audit(interfaceOf(subject));
	},
};

/** Все проверки по порядку пунктов. */
export const CHECKS: readonly Check[] = [
	undescribed,
	unimplemented,
	examples,
	returnsDescribed,
	readIsPure,
	interfaceCurrent,
	interfaceCompatible,
];
