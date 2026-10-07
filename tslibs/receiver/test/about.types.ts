/**
 * Что ловит `tsc` в описании ([S.14] (б), (г) и сверка схемы с параметром):
 * каждая строка под `@ts-expect-error` обязана быть ошибкой, иначе
 * `tsc --noEmit` гейта красный.
 */

import * as z from "zod";
import { type About, described } from "../index.ts";

class Plain {
	static readonly about: About<Plain> = {
		comment: "Простой.\nЗови в тесте.",
		methods: {},
	};

	printString(): string {
		return "Plain";
	}
}

class Bare {
	printString(): string {
		return "Bare";
	}
}

export class Card {
	show(): number {
		return 1;
	}

	comment(args: { text: string }): number {
		return args.text.length;
	}

	plain(): Plain {
		return new Plain();
	}

	printString(): string {
		return "Card";
	}
}

/** Без ключей у методов: поломка одного свойства не сбивает вывод схем. */
export class Shelf {
	show(): number {
		return 1;
	}

	plain(): Bare {
		return new Bare();
	}

	printString(): string {
		return "Shelf";
	}
}

const show = { comment: "Показать.\nЗови в тесте." } as const;
const comment = {
	comment: "Написать.\nЗови в тесте.",
	args: z.object({ text: z.string() }),
} as const;

/** Верное описание — без ошибок. */
export const good: About<Card> = described<Card>()({
	comment: "Карточка.\nЗови в тесте.",
	methods: {
		show,
		comment,
		plain: { comment: "x\nЗови в тесте.", returns: Plain },
	},
});

/** (г) `returns` — класс без `about`. */
export const bareReturns = described<Shelf>()({
	comment: "Полка.\nЗови в тесте.",
	methods: {
		show,
		// @ts-expect-error (г) `returns` — класс без `about`
		plain: { comment: "Голый.\nЗови в тесте.", returns: Bare },
	},
});

/** (б) описание без метода — при аннотации литералом. */
export const extraAnnotated: About<Card> = {
	comment: "Карточка.\nЗови в тесте.",
	methods: {
		show,
		comment,
		plain: { comment: "x\nЗови в тесте.", returns: Plain },
		// @ts-expect-error (б) описание без метода
		gone: { comment: "Нет такого.\nЗови в тесте." },
	},
};

/** (б) описание без метода — через `described`. */
export const extraChecked = described<Card>()({
	comment: "Карточка.\nЗови в тесте.",
	methods: {
		show,
		comment,
		plain: { comment: "x\nЗови в тесте.", returns: Plain },
		// @ts-expect-error (б) описание без метода
		gone: { comment: "Нет такого.\nЗови в тесте." },
	},
});

/** (а) метод без описания. */
export const missing = described<Card>()({
	comment: "Карточка.\nЗови в тесте.",
	// @ts-expect-error (а) нет описания `comment` и `plain`
	methods: { show },
});

/** Схема с лишним ключом против параметра метода. */
export const extraKey = described<Card>()({
	comment: "Карточка.\nЗови в тесте.",
	methods: {
		show,
		plain: { comment: "x\nЗови в тесте.", returns: Plain },
		comment: {
			comment: "Написать.\nЗови в тесте.",
			// @ts-expect-error схема не равна параметру метода
			args: z.object({ text: z.string(), extra: z.number() }),
		},
	},
});

/** Схема с неверным видом ключа. */
export const wrongKind = described<Card>()({
	comment: "Карточка.\nЗови в тесте.",
	methods: {
		show,
		plain: { comment: "x\nЗови в тесте.", returns: Plain },
		comment: {
			comment: "Написать.\nЗови в тесте.",
			// @ts-expect-error схема не равна параметру метода
			args: z.object({ text: z.number() }),
		},
	},
});

/** Два метода без ключей — для сверки замены устаревшего. */
export class Pair {
	show(): number {
		return 1;
	}

	check(): number {
		return 2;
	}

	printString(): string {
		return "Pair";
	}
}

/** Замена устаревшего — описанный селектор. */
export const goodReplacement = described<Pair>()({
	comment: "Пара.\nЗови в тесте.",
	methods: {
		check: { comment: "Отметить.\nЗови в тесте." },
		show: {
			comment: "Показать.\nЗови в тесте.",
			deprecated: { use: "check", since: "0.1.0" },
		},
	},
});

/** Замена устаревшего — только описанный селектор. */
export const badReplacement = described<Pair>()({
	comment: "Пара.\nЗови в тесте.",
	methods: {
		check: { comment: "Отметить.\nЗови в тесте." },
		show: {
			comment: "Показать.\nЗови в тесте.",
			// @ts-expect-error `use` — не селектор `Pair`
			deprecated: { use: "nope", since: "0.1.0" },
		},
	},
});

/** Описание метода без строки «когда звать». */
export const noWhen = described<Pair>()({
	comment: "Пара.",
	methods: {
		check: { comment: "Отметить.\nЗови в тесте." },
		// @ts-expect-error `comment` метода — две строки: что делает и когда звать
		show: { comment: "Показать." },
	},
});
