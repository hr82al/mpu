/**
 * Оракул полноты для deno-вида проекта (`platform/code-analyzer.md`,
 * «Оракул полноты»).
 *
 * Второй оракул, а не параметр к первому: эталон обязан приходить не из
 * нашего кода. У tsconfig-дерева его даёт проверка типов компилятором, у
 * deno-дерева — родной `deno check`. Подставить `deno check` в общий код
 * значило бы сравнивать ответ с самим собой, а мутация портила бы обе
 * стороны сравнения разом.
 *
 * Тест идёт под Vitest с `-A`: права Deno тесты не воспроизводят
 * (решение владельца 2026-10-07), и права задачи `test` его больше не
 * касаются (`deno.jsonc`, `platform/vitest-v6.md` [S.5]).
 */

import type { RefsResult } from "./refs.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRefs } from "./cmd_refs.ts";
import { openDenoFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

/**
 * Потребители `addDays` на deno-дереве. Записаны буквально: величина,
 * которую проверка читает, не должна приходить из того же кода, что её
 * порождает.
 */
const CONSUMERS: readonly string[] = [
  "mod.ts",
  "src/seed_test.ts",
  "src/window.ts",
];

describe("ответ на deno-дереве совпадает с оракулом deno check", () => {
  let temp: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openDenoFixture(temp);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("оракул даёт три файла", async () => {
    expect(
      await renameOracle(repo.root, "src/days.ts", "addDays"),
    ).toStrictEqual(CONSUMERS);
  });

  it("ответ команды равен ответу оракула", async () => {
    const result = await runRefs(
      { address: "deno-fixture:src/days.ts:3", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    expect(
      answered(result).consumers.places.map((place) => place.path),
    ).toStrictEqual(CONSUMERS);
    expect(answered(result).consumers.total).toStrictEqual(CONSUMERS.length);
  });
});

/**
 * Оракул: переименовать объявление, проверить типы родным `deno check`,
 * вычесть базовый прогон. Возвращает файлы, сломавшиеся от
 * переименования.
 */
async function renameOracle(
  root: string,
  path: string,
  name: string,
): Promise<readonly string[]> {
  const target = `${root}/${path}`;
  const source = await readFile(target, "utf8");
  const base = await brokenFiles(root);
  await writeFile(
    target,
    source.replaceAll(
      new RegExp(`\\b${name}\\b`, "g"),
      `${name}RenamedByOracle`,
    ),
  );
  try {
    const renamed = await brokenFiles(root);
    return renamed.filter((file) => !base.includes(file));
  } finally {
    // Дерево возвращается к исходному состоянию: второй прогон не
    // должен видеть следов первого.
    await writeFile(target, source);
  }
}

/** Файлы, о которых `deno check` сообщает ошибкой. */
async function brokenFiles(root: string): Promise<readonly string[]> {
  const child = spawn("deno", ["check", "."], {
    cwd: root,
    // Без `NO_COLOR` путь в выводе обёрнут управляющими
    // последовательностями, и двоеточие после него отделено от пути —
    // разбор ловил бы пустоту и молча давал бы пустой перечень.
    // Окружение — родителя плюс своё: `env` у `spawn` заменяет его целиком.
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let text = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (text += chunk));
  const [code] = await once(child, "close");
  const found = new Set<string>();
  // `deno check` печатает место ошибки строкой вида
  // `    at file:///…/src/window.ts:3:10`; берётся путь от корня дерева.
  // Пустой перечень при ненулевом коде значит, что разбор вывода
  // разошёлся с его формой, — это отказ, а не «ошибок нет».
  for (const match of text.matchAll(/\s+at file:\/\/(\/[^\s:]+):\d+:\d+/g)) {
    const file = match[1];
    if (file.startsWith(`${root}/`)) found.add(file.slice(root.length + 1));
  }
  if (code !== 0 && found.size === 0) {
    throw new Error(`вывод deno check не разобран: ${text}`);
  }
  return [...found].sort();
}

/** Ответивший раздел результата; отказ в этих проверках не ожидается. */
function answered(result: { section: { kind: string } }) {
  if (result.section.kind !== "answer") {
    throw new Error(`раздел отказал: ${JSON.stringify(result.section)}`);
  }
  return result.section as Extract<RefsResult["section"], { kind: "answer" }>;
}
