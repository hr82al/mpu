/**
 * `bun run interface`: файлы интерфейса тестового домена — голдены
 * `test/interface.test.ts`.
 */

import { fileURLToPath } from "node:url";
import { writeInterface } from "../../index.ts";
import { Kaiten } from "./domain.ts";

writeInterface({
	root: Kaiten,
	path: ["kaiten"],
	dir: fileURLToPath(new URL(".", import.meta.url)),
}).catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
