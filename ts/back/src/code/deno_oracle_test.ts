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
 * Право запускать `deno` задача `test` несёт отдельной строкой с
 * обоснованием (`deno.jsonc`, согласовано владельцем 2026-09-08): снять
 * его — и этот тест падает на `NotCapable`, а не молча зеленеет.
 */

import type { RefsResult } from "./refs.ts";
import { assertEquals } from "@std/assert";
import { runRefs } from "./cmd_refs.ts";
import { openDenoFixture } from "./testing.ts";

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

Deno.test("ответ на deno-дереве совпадает с оракулом deno check", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openDenoFixture(temp);

    await t.step("оракул даёт три файла", async () => {
      assertEquals(
        await renameOracle(repo.root, "src/days.ts", "addDays"),
        CONSUMERS,
      );
    });

    await t.step("ответ команды равен ответу оракула", async () => {
      const result = await runRefs(
        { address: "deno-fixture:src/days.ts:3", limit: 200 },
        { cwd: () => repo.root },
        [repo],
      );
      assertEquals(
        answered(result).consumers.places.map((place) => place.path),
        CONSUMERS,
      );
      assertEquals(answered(result).consumers.total, CONSUMERS.length);
    });
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
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
  const source = await Deno.readTextFile(target);
  const base = await brokenFiles(root);
  await Deno.writeTextFile(
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
    await Deno.writeTextFile(target, source);
  }
}

/** Файлы, о которых `deno check` сообщает ошибкой. */
async function brokenFiles(root: string): Promise<readonly string[]> {
  const output = await new Deno.Command("deno", {
    args: ["check", "."],
    cwd: root,
    // Без `NO_COLOR` путь в выводе обёрнут управляющими
    // последовательностями, и двоеточие после него отделено от пути —
    // разбор ловил бы пустоту и молча давал бы пустой перечень.
    env: { NO_COLOR: "1" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stderr);
  const found = new Set<string>();
  // `deno check` печатает место ошибки строкой вида
  // `    at file:///…/src/window.ts:3:10`; берётся путь от корня дерева.
  // Пустой перечень при ненулевом коде значит, что разбор вывода
  // разошёлся с его формой, — это отказ, а не «ошибок нет».
  for (const match of text.matchAll(/\s+at file:\/\/(\/[^\s:]+):\d+:\d+/g)) {
    const file = match[1];
    if (file.startsWith(`${root}/`)) found.add(file.slice(root.length + 1));
  }
  if (output.code !== 0 && found.size === 0) {
    throw new Error(`вывод deno check не разобран: ${text}`);
  }
  return [...found].sort();
}

/** Ответивший раздел результата; отказ в этих проверках не ожидается. */
function answered(result: { section: { kind: string } }) {
  if (result.section.kind !== "answer") {
    throw new Error(`раздел отказал: ${JSON.stringify(result.section)}`);
  }
  return result.section as Extract<
    RefsResult["section"],
    { kind: "answer" }
  >;
}
