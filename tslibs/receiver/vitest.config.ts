/**
 * Vitest библиотеки: один и тот же раннер под Bun, Node и Deno
 * (`bun run test:bun`, `test:node`, `test:deno`).
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		exclude: ["**/node_modules/**", "dist/**"],
		// Машину делят несколько сессий: предел воркеров задаёт хост.
		maxWorkers: 2,
		minWorkers: 1,
		coverage: {
			provider: "istanbul",
			include: ["src/**", "index.ts", "testing.ts"],
			reporter: ["text"],
		},
	},
});
