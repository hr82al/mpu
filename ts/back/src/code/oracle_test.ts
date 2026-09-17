/**
 * Тест полноты (`platform/code-analyzer.md`, «Оракул полноты»).
 *
 * Полнота не заявляется, а измеряется: полный список потребителей
 * символа — множество мест, где сборка ломается, если символ
 * переименовать. Оракул здесь исполним и потому исполняется.
 *
 * Программу оракул строит **своими руками**, а не тем же кодом, что и
 * анализатор: иначе мутация «не снимать `exclude`» или «не читать
 * `paths`» испортила бы обе стороны сравнения одинаково и тест остался
 * бы зелёным — ровно тот случай, когда эффект восстанавливается ниже по
 * коду (`ts/CLAUDE.md`, «Мутацию выбирают со стороны проверки»).
 * Поэтому утверждений три: ответ команды равен перечню, оракул равен
 * перечню, и перечень записан в тесте буквально.
 */

import ts from "typescript";
import type { RefsResult } from "./refs.ts";
import { assertEquals } from "@std/assert";
import { runRefs } from "./cmd_refs.ts";
import { openFixture } from "./testing.ts";

/**
 * Потребители `addDays` на дереве-фикстуре. Каждый попал сюда своей
 * формой получения символа — статическим импортом, алиасом конфигурации,
 * реэкспортом и динамическим `import()`; форма на попадание не влияет.
 * Записаны буквально:
 * величина, которую проверка читает, не должна приходить из того же
 * кода, что её порождает. `src/broken.ts` в перечень не входит — он
 * ошибочен и в базовом прогоне, поэтому в разность оракула не попадает.
 */
const CONSUMERS: readonly string[] = [
  "src/aliased.ts",
  "src/dynamic.ts",
  "src/grid.ts",
  "src/index.ts",
  "src/report.spec.ts",
  "src/seed_test.ts",
  "src/window.ts",
];

Deno.test("ответ команды совпадает с оракулом полноты", async (t) => {
  const temp = await Deno.makeTempDir();
  try {
    const repo = await openFixture(temp);

    await t.step("оракул на дереве-фикстуре даёт семь файлов", () => {
      assertEquals(
        renameOracle(repo.root, "src/days.ts", "addDays"),
        CONSUMERS,
      );
    });

    await t.step("ответ команды равен ответу оракула", async () => {
      const result = await runRefs(
        { address: "fixture:src/days.ts:2", limit: 200 },
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
 * Оракул: переименовать объявление, проверить типы, вычесть базовый
 * прогон. Возвращает файлы, сломавшиеся от переименования.
 */
function renameOracle(
  root: string,
  path: string,
  name: string,
): readonly string[] {
  const target = `${root}/${path}`;
  const source = Deno.readTextFileSync(target);
  const base = brokenFiles(root);
  const renamed = brokenFiles(
    root,
    target,
    source.replaceAll(
      new RegExp(`\\b${name}\\b`, "g"),
      `${name}RenamedByOracle`,
    ),
  );
  return renamed.filter((file) => !base.includes(file));
}

/**
 * Файлы с ошибками типов. Конфигурация собирается здесь заново и
 * буквально — без обращения к коду анализатора.
 */
function brokenFiles(
  root: string,
  overridePath?: string,
  overrideText?: string,
): readonly string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    paths: { "#/*": ["./src/*"] },
    baseUrl: root,
  };
  const files = sourceFiles(`${root}/src`);
  const host = ts.createCompilerHost(options);
  if (overridePath !== undefined && overrideText !== undefined) {
    const read = host.readFile.bind(host);
    host.readFile = (file) => file === overridePath ? overrideText : read(file);
    const get = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
      file === overridePath
        ? ts.createSourceFile(file, overrideText, languageVersion)
        : get(file, languageVersion, onError, shouldCreate);
  }
  const program = ts.createProgram(files, options, host);
  const broken = new Set<string>();
  for (const diagnostic of program.getSemanticDiagnostics()) {
    if (diagnostic.file === undefined) continue;
    broken.add(diagnostic.file.fileName.slice(root.length + 1));
  }
  return [...broken].sort();
}

/** Все `.ts` каталога: список файлов проекта без чтения конфигурации. */
function sourceFiles(dir: string): readonly string[] {
  return [...Deno.readDirSync(dir)]
    .filter((entry) => entry.isFile && entry.name.endsWith(".ts"))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
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
