/**
 * `bun run interface` домена: записать `INTERFACE.md` и `interface.json`,
 * если новый интерфейс совместим с прежним на диске.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Baseline, baseline, MissingBaseline } from "./compat.ts";
import {
	interfaceJson,
	interfaceMarkdown,
	interfaceOf,
	type Root,
} from "./interface.ts";

/** Новый интерфейс несовместим с прежним — файлы не тронуты. */
export class InterfaceBreach extends Error {
	override readonly name = "InterfaceBreach";
	/** Нарушения по строке. */
	readonly breaches: readonly string[];

	constructor(found: readonly string[]) {
		super(`интерфейс несовместим с прежним:\n${found.join("\n")}`);
		this.breaches = [...found];
	}
}

/** Где домен держит файлы интерфейса. */
export interface InterfaceTarget<T> extends Root<T> {
	readonly dir: string;
}

/** Прежний `interface.json` в `dir`; файла нет — `MissingBaseline`. */
export async function previousInterface(dir: string): Promise<Baseline> {
	const path = join(dir, "interface.json");
	try {
		return baseline(await readFile(path, "utf8"));
	} catch (error) {
		if (isMissing(error)) return new MissingBaseline(path);
		throw new Error(`read interface ${path}`, { cause: error });
	}
}

/** Файла нет — код `ENOENT` ошибки `node:fs`, граница ФС. */
function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Записать оба файла интерфейса домена в `target.dir`. */
export async function writeInterface<T>(
	target: InterfaceTarget<T>,
): Promise<void> {
	const previous = await previousInterface(target.dir);
	const found = previous.breaches(interfaceOf(target));
	if (found.length > 0) throw new InterfaceBreach(found);
	await writeFile(join(target.dir, "interface.json"), interfaceJson(target));
	await writeFile(join(target.dir, "INTERFACE.md"), interfaceMarkdown(target));
}
