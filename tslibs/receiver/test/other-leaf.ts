/** Второй класс с именем `Leaf` — в своём модуле, чтобы сборка не переименовала его. */

import type { About } from "../index.ts";

/** Другой лист: то же имя, другой класс. */
export class Leaf {
	static readonly about: About<Leaf> = { comment: "Другой лист.", methods: {} };

	printString(): string {
		return "Leaf";
	}
}
