/**
 * Фейк доски Kaiten для тестового домена: карточки в памяти и счётчик
 * записей — по нему набор соответствия ловит читающий метод, который пишет.
 */

/** Пункт чек-листа карточки. */
export interface Item {
	readonly text: string;
	readonly done: boolean;
}

interface Card {
	readonly title: string;
	readonly comments: string[];
	readonly items: Item[];
}

/** Доска в памяти. */
export class Board {
	readonly #cards = new Map<number, Card>();
	#writes = 0;

	constructor(cards: Readonly<Record<number, string>>) {
		for (const [id, title] of Object.entries(cards)) {
			this.#cards.set(Number(id), {
				title,
				comments: [],
				items: [{ text: "собрать", done: false }],
			});
		}
	}

	/** Заголовок карточки; нет карточки — ошибка. */
	title(id: number): string {
		return this.#card(id).title;
	}

	comment(id: number, text: string): void {
		this.#writes += 1;
		this.#card(id).comments.push(text);
	}

	items(id: number): Item[] {
		return this.#card(id).items.map((item) => ({ ...item }));
	}

	check(id: number, item: number): void {
		this.#writes += 1;
		const items = this.#card(id).items;
		items[item] = { ...(items[item] ?? { text: "", done: false }), done: true };
	}

	/** Сколько записей было — монотонно. */
	writes(): number {
		return this.#writes;
	}

	#card(id: number): Card {
		const card = this.#cards.get(id);
		if (card === undefined) throw new Error(`нет карточки ${id}`);
		return card;
	}
}
