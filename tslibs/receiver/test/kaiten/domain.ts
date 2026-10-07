/**
 * Тестовый домен библиотеки: `Kaiten` → `Card` → `Checklist`. Классы
 * объявлены от листа к корню: `returns` ссылается на уже объявленный класс.
 */

import * as z from "zod";
import { type About, described } from "../../index.ts";
import type { Board, Item } from "./board.ts";

/** Чек-лист карточки. */
export class Checklist {
	static readonly about: About<Checklist> = described<Checklist>()({
		comment: "Чек-лист карточки.",
		methods: {
			items: {
				comment: "Пункты чек-листа.\nЗови, чтобы узнать, что осталось сделать.",
				examples: [{ answer: [{ text: "собрать", done: false }] }],
			},
			check: {
				comment: "Отметить пункт сделанным.\nЗови, когда пункт выполнен.",
				args: z.object({ item: z.number().int().describe("номер пункта с 0") }),
				effect: "write",
				examples: [{ args: { item: 0 }, answer: { ok: true } }],
			},
			tick: {
				comment:
					"Отметить пункт (прежнее имя check).\nНе зови: устарел, зови check.",
				args: z.object({ item: z.number().int().describe("номер пункта с 0") }),
				effect: "write",
				deprecated: { use: "check", since: "0.1.0" },
			},
		},
	});

	readonly #board: Board;
	readonly #card: number;

	constructor(board: Board, card: number) {
		this.#board = board;
		this.#card = card;
	}

	items(): Item[] {
		return this.#board.items(this.#card);
	}

	check(args: { item: number }): { ok: true } {
		this.#board.check(this.#card, args.item);
		return { ok: true };
	}

	tick(args: { item: number }): { ok: true } {
		return this.check(args);
	}

	printString(): string {
		return `Checklist ${this.#card}`;
	}
}

/** Карточка доски. */
export class Card {
	static readonly about: About<Card> = described<Card>()({
		comment: "Карточка Kaiten.",
		methods: {
			show: {
				comment:
					"Номер и заголовок карточки.\nЗови, чтобы узнать, о чём карточка.",
				raises: ["нет карточки — номер не найден на доске"],
				examples: [{ answer: { id: 123, title: "Сборка" } }],
			},
			comment: {
				comment:
					"Оставить комментарий.\nЗови, когда нужно ответить в карточке.",
				args: z.object({ text: z.string().describe("текст комментария") }),
				effect: "write",
				examples: [{ args: { text: "ок" }, answer: { ok: true } }],
			},
			checklist: {
				comment: "Чек-лист карточки.\nЗови, чтобы работать с пунктами.",
				returns: Checklist,
				examples: [{ answer: "Checklist 123" }],
			},
		},
	});

	readonly #board: Board;
	readonly #id: number;

	constructor(board: Board, id: number) {
		this.#board = board;
		this.#id = id;
	}

	show(): { id: number; title: string } {
		return { id: this.#id, title: this.#board.title(this.#id) };
	}

	comment(args: { text: string }): { ok: true } {
		this.#board.comment(this.#id, args.text);
		return { ok: true };
	}

	checklist(): Checklist {
		return new Checklist(this.#board, this.#id);
	}

	printString(): string {
		return `Card ${this.#id}`;
	}
}

/** Корень домена: доска Kaiten. */
export class Kaiten {
	static readonly about: About<Kaiten> = described<Kaiten>()({
		comment: "Доска Kaiten.",
		methods: {
			card: {
				comment: "Карточка по номеру.\nЗови, чтобы работать с одной карточкой.",
				args: z.object({ id: z.number().int().describe("номер карточки") }),
				returns: Card,
				examples: [{ args: { id: 123 }, answer: "Card 123" }],
			},
			login: {
				comment: "Войти на доску.\nЗови, когда доска отвечает отказом входа.",
				args: z.object({
					user: z.string().describe("почта"),
					password: z.string().describe("пароль"),
				}),
				effect: "send",
				secret: ["password"],
				examples: [
					{ args: { user: "a@b.c", password: "p" }, answer: { user: "a@b.c" } },
				],
			},
		},
	});

	readonly #board: Board;

	constructor(board: Board) {
		this.#board = board;
	}

	card(args: { id: number }): Card {
		return new Card(this.#board, args.id);
	}

	async login(args: {
		user: string;
		password: string;
	}): Promise<{ user: string }> {
		return { user: args.user };
	}

	printString(): string {
		return "Kaiten";
	}
}
