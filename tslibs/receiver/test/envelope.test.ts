import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
	type About,
	agreed,
	allow,
	ask,
	deny,
	described,
	type Enveloped,
	envelope,
	JournalFailure,
	type Reply,
	type Rule,
	refused,
} from "../index.ts";
import {
	asking,
	MemoryJournal,
	navigated,
	outcome,
	rulesOf,
	steppingClock,
} from "../testing.ts";
import { ReturnsBare, Undescribed } from "./broken.ts";
import { Board } from "./kaiten/board.ts";
import { Card, Kaiten } from "./kaiten/domain.ts";

interface Setup {
	readonly rules?: Readonly<Record<string, Rule>>;
	readonly answer?: Reply;
	readonly signal?: AbortSignal;
}

function setup(given: Setup = {}) {
	const board = new Board({ 123: "Сборка" });
	const journal = new MemoryJournal();
	const asker = asking(given.answer ?? agreed);
	const ctx = {
		path: ["kaiten", "card"],
		rules: rulesOf(given.rules ?? {}),
		journal,
		asker,
		clock: steppingClock(5),
		signal: given.signal ?? new AbortController().signal,
	};
	const card: Enveloped<Card> = envelope(new Card(board, 123), ctx);
	const kaiten: Enveloped<Kaiten> = envelope(new Kaiten(board), {
		...ctx,
		path: ["kaiten"],
	});
	return { board, journal, asker, card, kaiten };
}

const ALLOW = { "kaiten card comment": allow };

describe("отправка через конверт", () => {
	it("[S.1] allow — ответ метода и запись журнала", async () => {
		const { card, journal, board } = setup({ rules: ALLOW });
		const answer = outcome(await card.send("comment", { text: "ок" }));
		expect(answer, "ответ метода").toStrictEqual({ value: { ok: true } });
		expect(journal.entries(), "журнал").toStrictEqual([
			{
				path: "kaiten card comment",
				args: { text: "ок" },
				outcome: "ok",
				ms: 5,
			},
		]);
		expect(board.writes(), "метод вызван").toBe(1);
	});

	it("[S.2] не хватает ключа — отказ, метод не вызван", async () => {
		const { card, journal, board } = setup({ rules: ALLOW });
		expect(outcome(await card.send("comment", {}))).toStrictEqual({
			refusal: {
				reason: "не хватает ключа",
				hint: null,
				candidates: [],
				text: "kaiten card comment: не хватает ключа text — пиши: kaiten card comment text: <строка>",
			},
		});
		expect(board.writes(), "метод не вызван").toBe(0);
		expect(journal.entries(), "журнала нет").toStrictEqual([]);
	});

	it("[S.2] аргументов нет вовсе — тот же отказ", async () => {
		const { card } = setup({ rules: ALLOW });
		expect(outcome(await card.send("comment"))).toMatchObject({
			refusal: { reason: "не хватает ключа" },
		});
	});

	it("[S.3] неверный ключ", async () => {
		const { card, board } = setup({ rules: ALLOW });
		expect(outcome(await card.send("comment", { text: 5 }))).toStrictEqual({
			refusal: {
				reason: "неверный ключ",
				hint: null,
				candidates: [],
				text: "kaiten card comment: ключ text — ожидается строка, пришло 5",
			},
		});
		expect(board.writes(), "метод не вызван").toBe(0);
	});

	it("неизвестный ключ — непонятно, ближайший ключ", async () => {
		const { card, board } = setup({ rules: ALLOW });
		expect(
			outcome(await card.send("comment", { text: "ок", txet: "ок" })),
		).toStrictEqual({
			refusal: {
				reason: "непонятно",
				hint: null,
				candidates: ["text"],
				text: "kaiten card comment не понимает ключ txet — ближе всего: text; понимаю: text",
			},
		});
		expect(board.writes(), "метод не вызван").toBe(0);
	});

	it("[S.4] deny — отказ, метод не вызван, журнал denied", async () => {
		const { card, journal, board } = setup({
			rules: { "kaiten card comment": deny },
		});
		expect(outcome(await card.send("comment", { text: "ок" }))).toStrictEqual({
			refusal: {
				reason: "запрещено правилом",
				hint: null,
				candidates: [],
				text: "kaiten card comment: запрещено правилом — изменить правила может только человек (mpu policy)",
			},
		});
		expect(board.writes(), "метод не вызван").toBe(0);
		expect(journal.entries()).toStrictEqual([
			{
				path: "kaiten card comment",
				args: { text: "ок" },
				outcome: "denied",
				ms: 5,
			},
		]);
	});

	it("[S.5] ask, ответ «да» — метод вызван", async () => {
		const { card, asker, board } = setup({
			rules: { "kaiten card comment": ask },
			answer: agreed,
		});
		expect(outcome(await card.send("comment", { text: "ок" }))).toStrictEqual({
			value: { ok: true },
		});
		expect(asker.questions(), "вопрос человеку").toStrictEqual([
			"kaiten card comment text: ок",
		]);
		expect(board.writes()).toBe(1);
	});

	it("[S.5] ask, ответ «нет» — отказ, журнал declined", async () => {
		const { card, journal, board } = setup({
			rules: { "kaiten card comment": ask },
			answer: refused,
		});
		expect(outcome(await card.send("comment", { text: "ок" }))).toStrictEqual({
			refusal: {
				reason: "не подтверждено",
				hint: null,
				candidates: [],
				text: "kaiten card comment: человек ответил «нет» — строка не исполнена",
			},
		});
		expect(board.writes(), "метод не вызван").toBe(0);
		expect(journal.entries()).toMatchObject([{ outcome: "declined" }]);
	});

	describe("[S.6] правила нет — из effect", () => {
		it("read → allow", async () => {
			const { card, asker } = setup();
			expect(outcome(await card.send("show"))).toStrictEqual({
				value: { id: 123, title: "Сборка" },
			});
			expect(asker.questions(), "не спрашивали").toStrictEqual([]);
		});

		it("write → ask", async () => {
			const { card, asker } = setup({ answer: refused });
			expect(outcome(await card.send("comment", { text: "ок" }))).toMatchObject(
				{
					refusal: { reason: "не подтверждено" },
				},
			);
			expect(asker.questions()).toStrictEqual(["kaiten card comment text: ок"]);
		});

		it("send → ask", async () => {
			const { kaiten, asker } = setup({ answer: refused });
			expect(
				outcome(await kaiten.send("login", { user: "a", password: "p" })),
			).toMatchObject({ refusal: { reason: "не подтверждено" } });
			expect(asker.questions()).toStrictEqual([
				"kaiten login user: a password: ***",
			]);
		});

		it("навигация → allow", async () => {
			const { card, asker } = setup({ answer: refused });
			expect(outcome(await card.send("checklist"))).toMatchObject({
				receiver: "Checklist 123",
			});
			expect(asker.questions()).toStrictEqual([]);
		});
	});

	it("[S.7] нет селектора — отказ непонятно с ближайшим", async () => {
		const { card } = setup();
		expect(outcome(await card.send("coment", { text: "ок" }))).toStrictEqual({
			refusal: {
				reason: "непонятно",
				hint: ["kaiten", "card", "comment"],
				candidates: ["comment"],
				text: "kaiten card не понимает coment — ближе всего: comment; понимаю: show, comment, checklist",
			},
		});
	});

	it("[S.7] ближайших нет — подсказки нет", async () => {
		const { card } = setup();
		expect(outcome(await card.send("xyzzy"))).toStrictEqual({
			refusal: {
				reason: "непонятно",
				hint: null,
				candidates: [],
				text: "kaiten card не понимает xyzzy; понимаю: show, comment, checklist",
			},
		});
	});

	it("[S.8] публичный неописанный метод домена — непонятно", async () => {
		const undescribed = envelope(new Undescribed(), {
			path: ["broken"],
			rules: rulesOf({}),
			journal: new MemoryJournal(),
			asker: asking(agreed),
			clock: steppingClock(1),
			signal: new AbortController().signal,
		});
		expect(outcome(await undescribed.send("archive"))).toMatchObject({
			refusal: { reason: "непонятно", candidates: [] },
		});
	});

	it("[S.8] служебные свойства — непонятно", async () => {
		const { card } = setup();
		for (const selector of [
			"printString",
			"constructor",
			"toString",
			"__proto__",
		]) {
			expect(outcome(await card.send(selector)), selector).toMatchObject({
				refusal: { reason: "непонятно" },
			});
		}
	});

	it("[S.9] навигация — тем же конвертом, путь продолжен", async () => {
		const { card, journal, asker } = setup({
			rules: { "kaiten card checklist check": deny },
		});
		const checklist = navigated(await card.send("checklist"));
		expect(checklist.describe().path).toBe("kaiten card checklist");
		expect(outcome(await checklist.send("check", { item: 0 }))).toMatchObject({
			refusal: {
				text: "kaiten card checklist check: запрещено правилом — изменить правила может только человек (mpu policy)",
			},
		});
		expect(asker.questions()).toStrictEqual([]);
		expect(journal.entries().map((e) => [e.path, e.outcome])).toStrictEqual([
			["kaiten card checklist", "ok"],
			["kaiten card checklist check", "denied"],
		]);
	});

	it("[S.11] секрет — *** в журнале, значения нет в отказе", async () => {
		const { kaiten, journal } = setup({ rules: { "kaiten login": allow } });
		await kaiten.send("login", { user: "a", password: "тайна" });
		expect(journal.entries()).toMatchObject([
			{ args: { user: "a", password: "***" }, outcome: "ok" },
		]);
		const wrong = outcome(
			await kaiten.send("login", { user: "a", password: 77 }),
		);
		expect(wrong).toMatchObject({
			refusal: {
				reason: "неверный ключ",
				text: "kaiten login: ключ password — ожидается строка, пришло ***",
			},
		});
		expect(JSON.stringify(wrong)).not.toContain("77");
		expect(kaiten.describe().methods.login?.examples, "пример").toStrictEqual([
			{ args: { user: "a@b.c", password: "***" }, answer: { user: "a@b.c" } },
		]);
		expect(kaiten.help("login"), "справка").not.toMatch(/password: p\b/);
	});

	it("[S.12] signal прерван — вызов не начинается", async () => {
		const aborted = new AbortController();
		aborted.abort();
		const { card, journal, board } = setup({
			rules: ALLOW,
			signal: aborted.signal,
		});
		expect(outcome(await card.send("comment", { text: "ок" }))).toStrictEqual({
			refusal: {
				reason: "отменено",
				hint: null,
				candidates: [],
				text: "kaiten card comment: отменено",
			},
		});
		expect(board.writes()).toBe(0);
		expect(journal.entries()).toStrictEqual([]);
	});

	describe("порядок проверок: отмена → понимание → ключи → правило", () => {
		it("отмена раньше понимания", async () => {
			const aborted = new AbortController();
			aborted.abort();
			const { card } = setup({ signal: aborted.signal });
			expect(outcome(await card.send("coment"))).toMatchObject({
				refusal: { reason: "отменено" },
			});
		});

		it("понимание раньше ключей", async () => {
			const { card } = setup({ rules: ALLOW });
			expect(outcome(await card.send("coment", { txet: 1 }))).toMatchObject({
				refusal: { reason: "непонятно", candidates: ["comment"] },
			});
		});

		it("ключи раньше правила deny: отказ ключа, журнала нет", async () => {
			const { card, journal } = setup({
				rules: { "kaiten card comment": deny },
			});
			expect(outcome(await card.send("comment", {}))).toMatchObject({
				refusal: { reason: "не хватает ключа" },
			});
			expect(journal.entries()).toStrictEqual([]);
		});

		it("ключи раньше вопроса человеку", async () => {
			const { card, asker } = setup({ answer: agreed });
			expect(outcome(await card.send("comment", { text: 5 }))).toMatchObject({
				refusal: { reason: "неверный ключ" },
			});
			expect(asker.questions()).toStrictEqual([]);
		});
	});

	it("сбой метода — журнал error, исключение дальше", async () => {
		const board = new Board({});
		const journal = new MemoryJournal();
		const card = envelope(new Card(board, 9), {
			path: ["kaiten", "card"],
			rules: rulesOf({}),
			journal,
			asker: asking(agreed),
			clock: steppingClock(1),
			signal: new AbortController().signal,
		});
		await expect(card.send("show")).rejects.toThrow("нет карточки 9");
		expect(journal.entries()).toMatchObject([{ outcome: "error" }]);
	});
});

describe("ключи: вход схемы, тотальный показ, уточнения", () => {
	class Tools {
		static readonly about: About<Tools> = described<Tools>()({
			comment: "Инструменты.",
			methods: {
				list: {
					comment: "Список.\nЗови в тесте.",
					args: z.object({
						limit: z.number().default(10),
						since: z.string().transform((text) => text.length),
					}),
				},
				pair: {
					comment: "Пара.\nЗови в тесте.",
					args: z
						.object({ from: z.number(), to: z.number() })
						.refine((range) => range.from <= range.to, "from больше to"),
				},
				load: { comment: "Загрузить.\nЗови в тесте." },
				lead: { comment: "Вести.\nЗови в тесте." },
				loud: { comment: "Громко.\nЗови в тесте." },
			},
		});

		list(args: { limit: number; since: number }): number {
			return args.limit + args.since;
		}

		pair(args: { from: number; to: number }): number {
			return args.to - args.from;
		}

		load(): number {
			return 1;
		}

		lead(): number {
			return 2;
		}

		loud(): number {
			return 3;
		}

		printString(): string {
			return "Tools";
		}
	}

	const tools = () =>
		envelope(new Tools(), {
			path: ["tools"],
			rules: rulesOf({}),
			journal: new MemoryJournal(),
			asker: asking(agreed),
			clock: steppingClock(1),
			signal: new AbortController().signal,
		});

	it("ключ с default необязателен, transform описан как значение", async () => {
		expect(tools().help("list").split("\n")[2]).toBe(
			"ключи: limit — число, необязательный; since — строка, обязательный",
		);
		expect(outcome(await tools().send("list", { since: "abc" }))).toStrictEqual(
			{
				value: 13,
			},
		);
		expect(outcome(await tools().send("list", {}))).toMatchObject({
			refusal: {
				text: "tools list: не хватает ключа since — пиши: tools list since: <строка>",
			},
		});
	});

	it("уточнение схемы целиком — отказ «неверные ключи» с сообщением автора", async () => {
		expect(
			outcome(await tools().send("pair", { from: 3, to: 1 })),
		).toStrictEqual({
			refusal: {
				reason: "неверные ключи",
				hint: null,
				candidates: [],
				text: "tools pair: неверные ключи — from больше to",
			},
		});
	});

	it("значение, которого нет в JSON, — отказ, а не исключение", async () => {
		expect(
			outcome(await tools().send("pair", { from: 5n, to: 1 })),
		).toMatchObject({
			refusal: { text: "tools pair: ключ from — ожидается число, пришло 5n" },
		});
	});

	it("несколько ближайших — по расстоянию, затем по алфавиту, без подсказки", async () => {
		expect(outcome(await tools().send("laad"))).toMatchObject({
			refusal: { hint: null, candidates: ["lead", "load", "loud"] },
		});
	});
});

describe("сбой журнала", () => {
	const failing = {
		write: async () => Promise.reject(new Error("диск полон")),
	};

	function card(board: Board) {
		return envelope(new Card(board, 123), {
			path: ["kaiten", "card"],
			rules: rulesOf({ "kaiten card comment": allow }),
			journal: failing,
			asker: asking(agreed),
			clock: steppingClock(1),
			signal: new AbortController().signal,
		});
	}

	it("после исполнения — JournalFailure, вызов исполнен", async () => {
		const board = new Board({ 123: "Сборка" });
		const failed = card(board).send("comment", { text: "ок" });
		await expect(failed).rejects.toThrow(JournalFailure);
		await expect(failed).rejects.toMatchObject({
			cause: { message: "диск полон" },
		});
		expect(board.writes(), "запись в домене сделана").toBe(1);
	});

	it("deny — JournalFailure с путём и исходом", async () => {
		const denying = envelope(new Card(new Board({ 123: "Сборка" }), 123), {
			path: ["kaiten", "card"],
			rules: rulesOf({ "kaiten card comment": deny }),
			journal: failing,
			asker: asking(agreed),
			clock: steppingClock(1),
			signal: new AbortController().signal,
		});
		await expect(denying.send("comment", { text: "ок" })).rejects.toThrow(
			"journal kaiten card comment denied: вызов не исполнен",
		);
	});

	it("метод бросил — обе ошибки в AggregateError", async () => {
		const failed = card(new Board({})).send("show");
		await expect(failed).rejects.toThrow(AggregateError);
		await expect(failed).rejects.toMatchObject({
			errors: [
				{ message: "нет карточки 123" },
				{ name: "JournalFailure", cause: { message: "диск полон" } },
			],
		});
	});
});

describe("класс без about в обход tsc", () => {
	it("навигация в него — получатель, который ничего не понимает", async () => {
		const root = envelope(new ReturnsBare(), {
			path: ["broken"],
			rules: rulesOf({}),
			journal: new MemoryJournal(),
			asker: asking(agreed),
			clock: steppingClock(1),
			signal: new AbortController().signal,
		});
		const bare = navigated(await root.send("bare"));
		expect(bare.printString()).toBe("Bare");
		expect(outcome(await bare.send("anything"))).toMatchObject({
			refusal: {
				reason: "непонятно",
				text: "broken bare не понимает anything; понимаю: ",
			},
		});
	});
});

describe("[S.10] отражение", () => {
	it("selectors, respondsTo, printString", () => {
		const { card } = setup();
		expect(card.selectors()).toStrictEqual({
			reading: ["show"],
			writing: ["comment"],
			navigation: ["checklist"],
		});
		expect(card.respondsTo("comment")).toBe(true);
		expect(card.respondsTo("x")).toBe(false);
		expect(card.respondsTo("printString")).toBe(false);
		expect(card.printString()).toBe("Card 123");
	});

	it("describe — about и путь", () => {
		const { card } = setup();
		const described = card.describe();
		expect(described.path).toBe("kaiten card");
		expect(described.comment).toBe("Карточка Kaiten.");
		expect(Object.keys(described.methods)).toStrictEqual([
			"show",
			"comment",
			"checklist",
		]);
		expect(described.methods.comment).toStrictEqual({
			comment: "Оставить комментарий.\nЗови, когда нужно ответить в карточке.",
			effect: "write",
			returns: "data",
			args: {
				type: "object",
				properties: {
					text: { type: "string", description: "текст комментария" },
				},
				required: ["text"],
				additionalProperties: false,
			},
			secret: [],
			raises: [],
			deprecated: null,
			examples: [{ args: { text: "ок" }, answer: { ok: true } }],
		});
	});

	it("help — однострока, когда звать, ключи, пример", () => {
		const { card } = setup();
		expect(card.help("comment")).toBe(
			[
				"kaiten card comment — Оставить комментарий.",
				"Зови, когда нужно ответить в карточке.",
				"ключи: text — строка, обязательный — текст комментария",
				'пример: kaiten card comment text: ок → {"ok":true}',
			].join("\n"),
		);
	});

	it("help неизвестного — текст отказа непонятно", () => {
		const { card } = setup();
		expect(card.help("coment")).toBe(
			"kaiten card не понимает coment — ближе всего: comment; понимаю: show, comment, checklist",
		);
	});
});
