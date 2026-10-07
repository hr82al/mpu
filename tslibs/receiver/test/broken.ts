/**
 * Сломанные домены для [S.14]: в каждом ровно одна поломка своей проверки.
 * Поломки, которые ловит `tsc`, проведены мимо него приведением — так их
 * видит проверка во время работы.
 */

import { type About, described, type ReceiverClass } from "../index.ts";
import { Leaf as OtherLeaf } from "./other-leaf.ts";

/** Фейк: счётчик записей. */
export class Tally {
	#writes = 0;

	write(): void {
		this.#writes += 1;
	}

	writes(): number {
		return this.#writes;
	}
}

/** (а) `private` метод — публичный во время работы, но без описания. */
export class Undescribed {
	static readonly about: About<Undescribed> = described<Undescribed>()({
		comment: "Поломка (а).\nЗови в тесте.",
		methods: {
			show: { comment: "Показать.\nЗови в тесте.", examples: [{ answer: 1 }] },
		},
	});

	show(): number {
		return this.archive() - 1;
	}

	private archive(): number {
		return 2;
	}

	printString(): string {
		return "Undescribed";
	}
}

/** (б) описание метода, которого нет. */
export class Unimplemented {
	// Мимо `tsc`: лишний ключ `gone` он ловит сам (`test/about.types.ts`).
	static readonly about = {
		comment: "Поломка (б).\nЗови в тесте.",
		methods: {
			show: { comment: "Показать.\nЗови в тесте." },
			gone: { comment: "Нет такого.\nЗови в тесте." },
		},
	} as unknown as About<Unimplemented>;

	show(): number {
		return 1;
	}

	printString(): string {
		return "Unimplemented";
	}
}

/** (в) пример с неверным ответом. */
export class WrongExample {
	static readonly about: About<WrongExample> = described<WrongExample>()({
		comment: "Поломка (в).\nЗови в тесте.",
		methods: {
			show: { comment: "Показать.\nЗови в тесте.", examples: [{ answer: 2 }] },
		},
	});

	show(): number {
		return 1;
	}

	printString(): string {
		return "WrongExample";
	}
}

/** Получатель без `about`. */
export class Bare {
	printString(): string {
		return "Bare";
	}
}

/** (г) `returns` — класс без `about`. */
export class ReturnsBare {
	static readonly about: About<ReturnsBare> = described<ReturnsBare>()({
		comment: "Поломка (г).\nЗови в тесте.",
		methods: {
			bare: {
				comment: "Голый получатель.\nЗови в тесте.",
				// Мимо `tsc`: класс без `about` он ловит сам (`test/about.types.ts`).
				returns: Bare as unknown as ReceiverClass<Bare>,
				examples: [{ answer: "Bare" }],
			},
		},
	});

	bare(): Bare {
		return new Bare();
	}

	printString(): string {
		return "ReturnsBare";
	}
}

/** (д) метод `read`, который пишет в фейк. */
export class WritingRead {
	static readonly about: About<WritingRead> = described<WritingRead>()({
		comment: "Поломка (д).\nЗови в тесте.",
		methods: {
			peek: {
				comment: "Посмотреть.\nЗови в тесте.",
				examples: [{ answer: 1 }],
			},
		},
	});

	readonly #tally: Tally;

	constructor(tally: Tally) {
		this.#tally = tally;
	}

	peek(): number {
		this.#tally.write();
		return 1;
	}

	printString(): string {
		return "WritingRead";
	}
}

/** Лист за навигацией без примера: его примеры не исполнить. */
export class Leaf {
	static readonly about: About<Leaf> = described<Leaf>()({
		comment: "Лист.",
		methods: {
			value: { comment: "Значение.\nЗови в тесте.", examples: [{ answer: 1 }] },
		},
	});

	value(): number {
		return 1;
	}

	printString(): string {
		return "Leaf";
	}
}

/** (в) до `Leaf` не ведёт ни один пример навигации. */
export class Unreached {
	static readonly about: About<Unreached> = described<Unreached>()({
		comment: "Поломка (в): класс не достижим примерами.",
		methods: { leaf: { comment: "Лист.\nЗови в тесте.", returns: Leaf } },
	});

	leaf(): Leaf {
		return new Leaf();
	}

	printString(): string {
		return "Unreached";
	}
}

/** (д) читающий метод без примера. */
export class Unverified {
	static readonly about: About<Unverified> = described<Unverified>()({
		comment: "Поломка (д): read без примера.",
		methods: { peek: { comment: "Посмотреть.\nЗови в тесте." } },
	});

	peek(): number {
		return 1;
	}

	printString(): string {
		return "Unverified";
	}
}

/** Пример записи объявлен раньше примера чтения: верно лишь на свежих фейках. */
export class Counter {
	static readonly about: About<Counter> = described<Counter>()({
		comment: "Счётчик записей.",
		methods: {
			bump: {
				comment: "Записать.\nЗови в тесте.",
				effect: "write",
				examples: [{ answer: 1 }],
			},
			count: { comment: "Сколько.\nЗови в тесте.", examples: [{ answer: 0 }] },
		},
	});

	readonly #tally: Tally;

	constructor(tally: Tally) {
		this.#tally = tally;
	}

	bump(): number {
		this.#tally.write();
		return this.#tally.writes();
	}

	count(): number {
		return this.#tally.writes();
	}

	printString(): string {
		return "Counter";
	}
}

/** Геттер на прототипе, читающий `#поле`: не метод, проверка его не исполняет. */
export class WithGetter {
	static readonly about: About<WithGetter> = described<WithGetter>()({
		comment: "Геттер.",
		methods: {
			show: { comment: "Показать.\nЗови в тесте.", examples: [{ answer: 1 }] },
		},
	});

	readonly #value = 1;

	get value(): number {
		return this.#value;
	}

	show(): number {
		return this.value;
	}

	printString(): string {
		return "WithGetter";
	}
}

/** Одноимённые разные классы в графе. */
export class TwoLeaves {
	static readonly about: About<TwoLeaves> = described<TwoLeaves>()({
		comment: "Два листа.",
		methods: {
			first: { comment: "Первый.\nЗови в тесте.", returns: Leaf },
			second: { comment: "Второй.\nЗови в тесте.", returns: OtherLeaf },
		},
	});

	first(): Leaf {
		return new Leaf();
	}

	second(): OtherLeaf {
		return new OtherLeaf();
	}

	printString(): string {
		return "TwoLeaves";
	}
}

/** Навигация, которая бросает на своём примере. */
export class ThrowingNav {
	static readonly about: About<ThrowingNav> = described<ThrowingNav>()({
		comment: "Навигация бросает.",
		methods: {
			leaf: {
				comment: "Лист.\nЗови в тесте.",
				returns: Leaf,
				examples: [{ answer: "Leaf" }],
			},
		},
	});

	leaf(): Leaf {
		throw new Error("boom");
	}

	printString(): string {
		return "ThrowingNav";
	}
}
