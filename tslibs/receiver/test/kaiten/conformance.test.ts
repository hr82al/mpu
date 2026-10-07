import { fileURLToPath } from "node:url";
import { conformance } from "../../testing.ts";
import { Board } from "./board.ts";
import { Kaiten } from "./domain.ts";

conformance({
	root: Kaiten,
	path: ["kaiten"],
	fakes: () => new Board({ 123: "Сборка" }),
	create: (board) => new Kaiten(board),
	dir: fileURLToPath(new URL(".", import.meta.url)),
});
