import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type Described,
	DuplicateClassName,
	type ReceiverClass,
} from "../index.ts";
import {
	type Check,
	examples,
	type Fakes,
	interfaceCompatible,
	interfaceCurrent,
	readIsPure,
	returnsDescribed,
	type Subject,
	undescribed,
	unimplemented,
} from "../src/conformance.ts";
import {
	Counter,
	ReturnsBare,
	Tally,
	ThrowingNav,
	TwoLeaves,
	Undescribed,
	Unimplemented,
	Unreached,
	Unverified,
	WithGetter,
	WritingRead,
	WrongExample,
} from "./broken.ts";
import { Board } from "./kaiten/board.ts";
import { Kaiten } from "./kaiten/domain.ts";

const KAITEN_DIR = fileURLToPath(new URL("./kaiten/", import.meta.url));

const kaiten = (dir = KAITEN_DIR): Subject<Kaiten, Board> => ({
	root: Kaiten,
	path: ["kaiten"],
	fakes: () => new Board({ 123: "Сборка" }),
	create: (board) => new Kaiten(board),
	dir,
});

function broken<T extends Described>(
	root: ReceiverClass<T>,
	create: (tally: Tally) => T,
): Subject<T, Fakes> {
	return {
		root,
		path: ["broken"],
		fakes: () => new Tally(),
		create: (fakes) => create(fakes as Tally),
		dir: KAITEN_DIR,
	};
}

async function withInterface<R>(
	edit: (json: {
		receivers: Record<string, { methods: Record<string, unknown> }>;
	}) => void,
	work: (dir: string) => Promise<R>,
): Promise<R> {
	const dir = await mkdtemp(join(tmpdir(), "receiver-"));
	try {
		const json = JSON.parse(
			await readFile(join(KAITEN_DIR, "interface.json"), "utf8"),
		);
		edit(json);
		await writeFile(
			join(dir, "interface.json"),
			`${JSON.stringify(json, null, 2)}\n`,
		);
		return await work(dir);
	} finally {
		await rm(dir, { recursive: true });
	}
}

interface Case {
	readonly check: Check;
	readonly breakage: () => Promise<string[]>;
	readonly want: readonly string[];
}

const CASES: readonly Case[] = [
	{
		check: undescribed,
		breakage: () =>
			undescribed.findings(broken(Undescribed, () => new Undescribed())),
		want: ["Undescribed.archive: метод без описания"],
	},
	{
		check: unimplemented,
		breakage: () =>
			unimplemented.findings(broken(Unimplemented, () => new Unimplemented())),
		want: ["Unimplemented.gone: описание без метода"],
	},
	{
		check: examples,
		breakage: () =>
			examples.findings(broken(WrongExample, () => new WrongExample())),
		want: ["WrongExample.show: пример ждёт 2, пришло 1"],
	},
	{
		check: returnsDescribed,
		breakage: () =>
			returnsDescribed.findings(broken(ReturnsBare, () => new ReturnsBare())),
		want: ["Bare: класс из returns без about"],
	},
	{
		check: readIsPure,
		breakage: () =>
			readIsPure.findings(
				broken(WritingRead, (tally) => new WritingRead(tally)),
			),
		want: ["WritingRead.peek: метод read записал в фейк 1 раз"],
	},
	{
		check: interfaceCurrent,
		breakage: () =>
			withInterface(
				(json) => {
					json.receivers.Card = {
						...json.receivers.Card,
						comment: "старое",
					} as never;
				},
				async (dir) =>
					(await interfaceCurrent.findings(kaiten(dir))).map((found) =>
						found.replace(dir, "<dir>"),
					),
			),
		want: [
			"<dir>/interface.json: не совпадает с about — запусти bun run interface",
		],
	},
	{
		check: interfaceCompatible,
		breakage: () =>
			withInterface(
				(json) => {
					const card = json.receivers.Card;
					if (card) card.methods.archive = card.methods.show;
				},
				(dir) => interfaceCompatible.findings(kaiten(dir)),
			),
		want: ["Card.archive: метод удалён без deprecated с заменой"],
	},
];

describe("[S.14] проверки соответствия", () => {
	for (const { check, breakage, want } of CASES) {
		describe(check.name, () => {
			it("тестовый домен — без находок", async () => {
				expect(await check.findings(kaiten())).toStrictEqual([]);
			});

			it("краснеет на своей поломке", async () => {
				expect(await breakage()).toStrictEqual(want);
			});
		});
	}
});

describe("[S.14] проверки не молчат о неисполненном", () => {
	it("(в) класс за навигацией без примера — находка", async () => {
		expect(
			await examples.findings(broken(Unreached, () => new Unreached())),
		).toStrictEqual([
			"Leaf.value: пример не исполнен — у навигации leaf нет примера",
		]);
	});

	it("(в) навигация бросила на примере — находка, а не исключение", async () => {
		expect(
			await examples.findings(broken(ThrowingNav, () => new ThrowingNav())),
		).toStrictEqual([
			"ThrowingNav.leaf: пример бросил: Error: boom",
			"Leaf.value: пример не исполнен — навигация leaf бросила: Error: boom",
		]);
	});

	it("(е) нечитаемый interface.json — находка с причиной", async () => {
		const dir = await mkdtemp(join(tmpdir(), "receiver-"));
		try {
			await mkdir(join(dir, "interface.json"));
			const [found = ""] = await interfaceCurrent.findings(kaiten(dir));
			expect(found).toContain("не прочитан (Error: EISDIR");
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("(д) читающий метод без примера — находка", async () => {
		expect(
			await readIsPure.findings(broken(Unverified, () => new Unverified())),
		).toStrictEqual(["Unverified.peek: метод read без примера — не проверен"]);
	});

	it("(в) каждый пример — на свежих фейках, порядок примеров не важен", async () => {
		const subject = broken(Counter, (tally) => new Counter(tally));
		expect(await examples.findings(subject)).toStrictEqual([]);
		expect(await readIsPure.findings(subject)).toStrictEqual([]);
	});

	it("(а)(б) геттер на прототипе не исполняется и методом не считается", async () => {
		const subject = broken(WithGetter, () => new WithGetter());
		expect(await undescribed.findings(subject)).toStrictEqual([]);
		expect(await unimplemented.findings(subject)).toStrictEqual([]);
	});

	it("одноимённые разные классы — ошибка, а не склейка", async () => {
		await expect(
			undescribed.findings(broken(TwoLeaves, () => new TwoLeaves())),
		).rejects.toThrow(DuplicateClassName);
	});

	it("(ж) прежнего interface.json нет — находка", async () => {
		const dir = await mkdtemp(join(tmpdir(), "receiver-"));
		try {
			expect(
				(await interfaceCompatible.findings(kaiten(dir))).map((found) =>
					found.replace(dir, "<dir>"),
				),
			).toStrictEqual([
				"<dir>/interface.json: нет прежнего interface.json — совместимость не проверена",
			]);
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});
