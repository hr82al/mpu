/**
 * Скрипты сборки частей (`platform/supervisor-install.md`, «Части»;
 * `platform/node-runtime.md`, [S.11]): каждая из семи программ —
 * `bun build --compile` своей точки входа в `$MPU_OUT`; у `back` и
 * `worker` вторым входом — воркер разбора кода. Версия супервизора — та
 * же, что у `back/src/version.ts`.
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { VERSION } from "./mod.ts";

/** Скрипт `package.json` словами; нет — тест красный. */
async function script(name: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const line = manifest.scripts[name];
  expect(line !== undefined, `нет скрипта ${name}`).toBe(true);
  return (line ?? "").split(/\s+/);
}

/** Слова самой сборки: после `bun build`, без подготовки перед ней. */
function build(words: readonly string[]): readonly string[] {
  const at = words.findIndex(
    (word, i) => word === "bun" && words[i + 1] === "build",
  );
  return at < 0 ? [] : words.slice(at);
}

/**
 * Входы программы с воркером разбора кода. Воркер — вторым входом:
 * `new Worker(new URL(…))` статическим импортом не является, и без
 * входа программа отвечает «модуль не найден» на вопрос по нескольким
 * репозиториям (smoke «code: разбор дерева…»). `--root` — его каталог:
 * вход ложится в корень файловой системы бинаря, куда указывает
 * `new URL("./repo_worker.ts", import.meta.url)` собранного кода.
 */
const WITH_WORKER = (entry: string) => [
  entry,
  "back/src/code/repo_worker.ts",
  "--root",
  "back/src/code",
];

describe("compile:* — bun build --compile точки входа в $MPU_OUT", () => {
  const entries: readonly (readonly [string, readonly string[]])[] = [
    ["compile:back", WITH_WORKER("back/back.ts")],
    ["compile:worker", WITH_WORKER("back/worker.ts")],
    ["compile:mcp", ["mcp/main.ts"]],
    ["compile:cli", ["cli/main.ts"]],
    ["compile:supervisor", ["supervisor/main.ts"]],
    ["compile:task", ["back/task.ts"]],
    ["compile:complete", ["complete/main.ts"]],
  ];
  for (const [name, inputs] of entries) {
    it(name, async () => {
      expect(build(await script(name))).toStrictEqual([
        "bun",
        "build",
        "--compile",
        ...inputs,
        "--outfile",
        "$MPU_OUT",
      ]);
    });
  }
});

it("версия супервизора — версия сборки back", async () => {
  const back = (await readFile("back/src/version.ts", "utf8")).match(
    /export const VERSION = "([^"]+)";/,
  )?.[1];
  expect(VERSION).toStrictEqual(back);
});
