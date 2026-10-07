import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { breaches, InterfaceBreach, writeInterface } from "../index.ts";
import { Kaiten } from "./kaiten/domain.ts";

const GOLDEN = fileURLToPath(new URL("./kaiten/", import.meta.url));

async function inTemp<R>(work: (dir: string) => Promise<R>): Promise<R> {
	const dir = await mkdtemp(join(tmpdir(), "receiver-"));
	try {
		return await work(dir);
	} finally {
		await rm(dir, { recursive: true });
	}
}

async function files(dir: string): Promise<[string, string]> {
	return [
		await readFile(join(dir, "INTERFACE.md"), "utf8"),
		await readFile(join(dir, "interface.json"), "utf8"),
	];
}

const KAITEN = { root: Kaiten, path: ["kaiten"] } as const;

describe("[S.13] файл интерфейса", () => {
	it("совпадает с голденом, повтор — байт в байт", async () => {
		const golden = await files(GOLDEN);
		await inTemp(async (dir) => {
			await writeInterface({ ...KAITEN, dir });
			const first = await files(dir);
			await writeInterface({ ...KAITEN, dir });
			expect(await files(dir), "повторный запуск").toStrictEqual(first);
			expect(first, "голден тестового домена").toStrictEqual(golden);
		});
	});

	it("несовместимое не пишется", async () => {
		await inTemp(async (dir) => {
			const json = await readFile(join(GOLDEN, "interface.json"), "utf8");
			const old = JSON.parse(json);
			old.receivers.Card.methods.archive = old.receivers.Card.methods.show;
			const before = `${JSON.stringify(old, null, 2)}\n`;
			await writeFile(join(dir, "interface.json"), before);
			await expect(writeInterface({ ...KAITEN, dir })).rejects.toThrow(
				InterfaceBreach,
			);
			expect(await readFile(join(dir, "interface.json"), "utf8")).toBe(before);
		});
	});
});

interface Shape {
	readonly required?: string[];
	readonly deprecated?: { readonly use: string; readonly since: string };
}

function iface(methods: Readonly<Record<string, Shape>>) {
	return {
		path: "kaiten",
		receivers: {
			Card: {
				path: "kaiten card",
				comment: "",
				methods: Object.fromEntries(
					Object.entries(methods).map(([selector, shape]) => [
						selector,
						{
							comment: "",
							effect: "read",
							returns: "data",
							args: {
								type: "object",
								properties: {},
								...(shape.required ? { required: shape.required } : {}),
							},
							secret: [],
							raises: [],
							deprecated: shape.deprecated ?? null,
							examples: [],
						},
					]),
				),
			},
		},
	};
}

describe("[S.14ж] совместимость интерфейса", () => {
	const cases = [
		{
			name: "тот же интерфейс",
			old: iface({ comment: { required: ["text"] } }),
			now: iface({ comment: { required: ["text"] } }),
			want: [],
		},
		{
			name: "метод удалён",
			old: iface({ show: {}, comment: {} }),
			now: iface({ comment: {} }),
			want: ["Card.show: метод удалён без deprecated с заменой"],
		},
		{
			name: "удалён устаревший, замена есть",
			old: iface({
				tick: { deprecated: { use: "check", since: "0.1.0" } },
				check: {},
			}),
			now: iface({ check: {} }),
			want: [],
		},
		{
			name: "удалён устаревший, замены нет",
			old: iface({ tick: { deprecated: { use: "check", since: "0.1.0" } } }),
			now: iface({}),
			want: ["Card.tick: метод удалён без deprecated с заменой"],
		},
		{
			name: "добавлен обязательный ключ",
			old: iface({ comment: { required: ["text"] } }),
			now: iface({ comment: { required: ["text", "author"] } }),
			want: [
				"Card.comment: новый обязательный ключ author — заведи новый метод, старый оставь deprecated с заменой",
			],
		},
		{
			name: "ключ стал необязательным, добавлен метод",
			old: iface({ comment: { required: ["text"] } }),
			now: iface({ comment: {}, show: { required: ["id"] } }),
			want: [],
		},
	];
	for (const { name, old, now, want } of cases) {
		it(name, () => {
			expect(breaches(old, now)).toStrictEqual(want);
		});
	}
});
