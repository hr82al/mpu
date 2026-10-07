/**
 * Граф домена: классы от корня по `returns`, в ширину, каждый с путём и
 * маршрутом первой встречи. Его читают и файл интерфейса, и проверки
 * соответствия; класс без `about` — свой узел `BareNode`, а не `undefined`.
 */

import type { ReceiverClass } from "./about.ts";
import type { Description, MethodDescription } from "./description.ts";
import type { ClassData, DescribedMethod } from "./method.ts";
import { Protocol } from "./protocol.ts";

/** Корень домена и его путь словами. */
export interface Root<T> {
	readonly root: ReceiverClass<T>;
	readonly path: readonly string[];
}

/** Шаг навигации от родителя: селектор и описанный метод. */
export interface Step {
	readonly selector: string;
	readonly method: DescribedMethod;
}

/** Страница метода в `INTERFACE.md`. */
export interface Page {
	readonly selector: string;
	readonly description: MethodDescription;
	readonly help: string;
}

/** Класс графа. */
export interface Node {
	readonly name: string;
	readonly path: readonly string[];
	/** Шаги навигации от корня до класса. */
	readonly route: readonly Step[];
	describe(): Description;
	pages(): Page[];
	methods(): DescribedMethod[];
	/** Находки (а). */
	undescribed(): string[];
	/** Находки (б). */
	unimplemented(): string[];
	/** Находки (г). */
	bare(): string[];
}

interface Place {
	readonly path: readonly string[];
	readonly route: readonly Step[];
}

class DescribedNode implements Node {
	readonly name: string;
	readonly path: readonly string[];
	readonly route: readonly Step[];
	readonly #protocol: Protocol;

	constructor(cls: ClassData, place: Place) {
		this.name = cls.name;
		this.path = place.path;
		this.route = place.route;
		this.#protocol = new Protocol(cls.prototype, cls);
	}

	describe(): Description {
		return { path: this.path.join(" "), ...this.#protocol.describe() };
	}

	pages(): Page[] {
		return this.#protocol.pages(this.path);
	}

	methods(): DescribedMethod[] {
		return this.#protocol.methods();
	}

	undescribed(): string[] {
		return this.#protocol
			.undescribed()
			.map((name) => `${this.name}.${name}: метод без описания`);
	}

	unimplemented(): string[] {
		return this.#protocol
			.unimplemented()
			.map((name) => `${this.name}.${name}: описание без метода`);
	}

	bare(): string[] {
		return [];
	}
}

/** Класс из `returns` без `about`: описывать и обходить нечего. */
class BareNode implements Node {
	readonly name: string;
	readonly path: readonly string[];
	readonly route: readonly Step[];

	constructor(cls: ClassData, place: Place) {
		this.name = cls.name;
		this.path = place.path;
		this.route = place.route;
	}

	describe(): Description {
		return { path: this.path.join(" "), comment: "", methods: {} };
	}

	pages(): Page[] {
		return [];
	}

	methods(): DescribedMethod[] {
		return [];
	}

	undescribed(): string[] {
		return [];
	}

	unimplemented(): string[] {
		return [];
	}

	bare(): string[] {
		return [`${this.name}: класс из returns без about`];
	}
}

/** Узел класса: есть ли `about` — данные автора на границе, решается здесь один раз. */
function nodeOf(cls: ClassData, place: Place): Node {
	return Reflect.get(cls, "about") === undefined
		? new BareNode(cls, place)
		: new DescribedNode(cls, place);
}

/** Класс домена данными конверта. */
export function classOf<T>(cls: ReceiverClass<T>): ClassData {
	// `ReceiverClass<T>` и `ClassData` — один класс: `T` описан и умеет
	// `printString` по типу `About<T>`; обобщённое `About<T>` присваиванием
	// к записи методов не сводится.
	return cls as unknown as ClassData;
}

/** Два разных класса с одним именем: интерфейс по имени их склеил бы. */
export class DuplicateClassName extends Error {
	override readonly name = "DuplicateClassName";
}

interface Visit extends Place {
	readonly cls: ClassData;
}

/** Классы домена от корня. */
export class Graph {
	readonly #nodes: readonly Node[];

	constructor(nodes: readonly Node[]) {
		this.#nodes = nodes;
	}

	/** Граф домена `domain`; одноимённые разные классы — `DuplicateClassName`. */
	static of<T>(domain: Root<T>): Graph {
		const seen = new Map<ClassData, Node>();
		const names = new Map<string, ClassData>();
		const queue: Visit[] = [
			{ cls: classOf(domain.root), path: domain.path, route: [] },
		];
		for (let visit = queue.shift(); visit; visit = queue.shift()) {
			if (seen.has(visit.cls)) continue;
			const named = names.get(visit.cls.name) ?? visit.cls;
			if (named !== visit.cls) {
				throw new DuplicateClassName(`два класса с именем ${visit.cls.name}`);
			}
			names.set(visit.cls.name, visit.cls);
			const node = nodeOf(visit.cls, visit);
			seen.set(visit.cls, node);
			queue.push(...next(node, visit));
		}
		return new Graph([...seen.values()]);
	}

	nodes(): Node[] {
		return [...this.#nodes];
	}
}

function next(node: Node, from: Visit): Visit[] {
	return node.methods().flatMap((method) =>
		method.classes().map((cls) => ({
			cls,
			path: [...from.path, method.selector],
			route: [...from.route, { selector: method.selector, method }],
		})),
	);
}
