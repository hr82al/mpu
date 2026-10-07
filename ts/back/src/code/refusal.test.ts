/**
 * Отказ раздела (`platform/code-analyzer.md`). Условий здесь два, и
 * причина у каждого своя: программа проекта не строится (ошибка
 * конфигурации) — и конфигурации есть, а непустого состава ни у одной.
 *
 * Отказ печатается ВМЕСТО перечня в своём разделе и в stdout, а не
 * уходит в stderr: он относится к репозиторию, а не к вызову. Замер
 * спецификатора 2026-09-08: один репозиторий без установленных
 * зависимостей обнулял ответ по всем восьми.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderRefs, runRefs } from "./cmd_refs.ts";
import { runName } from "./cmd_name.ts";
import { refsResultSchema } from "./refs.ts";
import { openBrokenFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

it("отказ раздела совпадает с голденом спеки", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openBrokenFixture(temp);
    const result = await runRefs(
      { address: "broken-fixture:src/a.ts:4", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    expect(renderRefs(result)).toStrictEqual(
      await readFile(
        new URL("testdata/code/refs-refused.stdout.txt", import.meta.url),
        "utf8",
      ),
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("у отказавшего раздела нет ни гарантии, ни разделов", () => {
  let temp: string;
  let repo: Repo;
  let result: {
    section: {
      kind: "answer";
      mark: {
        repo: string;
        git: { branch: string; commit: string; dirty: boolean } | null;
      };
      guarantee: "types" | "text";
      target: { kind: "symbol" | "module"; path: string; line: number | null };
      symbol: {
        name: string;
        signature: string;
        scope:
          | "entry"
          | "module-only"
          | "no-entry"
          | "entry-unparsed"
          | "entry-not-object"
          | "private";
      } | null;
      consumers: { total: number; places: { path: string; line: number }[] };
      unresolved: {
        total: number;
        items: {
          path: string;
          line: number;
          specifier: string;
          reason: string;
        }[];
      };
    } | {
      kind: "refused";
      mark: {
        repo: string;
        git: { branch: string; commit: string; dirty: boolean } | null;
      };
      refusal: string;
    };
  };
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openBrokenFixture(temp);
    result = await runRefs(
      { address: "broken-fixture:src/a.ts:4", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("раздел размечен как отказавший", () => {
    // Гарантия — свойство ответа: она говорит, насколько полон
    // перечень. Там, где перечня нет, заявлять о полноте нечего, и
    // типом такого состояния просто не существует.
    expect(result.section.kind).toBe("refused");
  });

  it("причина названа и указывает на конфигурацию", () => {
    const section = result.section;
    expect(section.kind, JSON.stringify(section)).toBe("refused");
    if (section.kind !== "refused") throw new Error("раздел не отказал");
    expect(section.refusal).toStrictEqual(
      "конфигурация проекта tsconfig.json не разбирается: " +
        "File '@nowhere/base.json' not found.",
    );
  });

  it("ответ проходит объявленную схему", () => {
    // Отказ — такой же ответ команды, и схема результата обязана его
    // принимать: иначе точка входа отдала бы его агенту не по схеме.
    refsResultSchema.parse(result);
  });
});

/** Репозиторий с конфигурацией, у которой нет ни одного исходника. */
async function hollowRepo(
  root: string,
  config: "tsconfig" | "deno",
): Promise<Repo> {
  await mkdir(`${root}/src`, { recursive: true });
  const [name, text] = config === "deno" ? ["deno.json", "{}\n"] : [
    "tsconfig.json",
    '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n',
  ];
  await writeFile(`${root}/${name}`, text);
  return {
    name: "hollow",
    root,
    mark: () =>
      Promise.resolve({ repo: "hollow", state: { kind: "out-of-git" } }),
  };
}

it("проекты есть, а программ нет — причина называет это", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Конфигурация есть, а состава у неё нет: `include` указывает в
    // пустой каталог. «Нет ни одного проекта» здесь было бы неправдой —
    // искать пришлось бы не то, чего не хватает.
    const repo = await hollowRepo(`${temp}/hollow`, "tsconfig");
    const result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    // Один репозиторий — один раздел; иначе проверка утверждала бы про
    // не тот.
    expect(result.sections.length).toBe(1);
    const section = result.sections[0];
    expect(section.kind, JSON.stringify(section)).toBe("refused");
    if (section.kind !== "refused") throw new Error("раздел не отказал");
    expect(section.refusal).toStrictEqual(
      "объявления не разбираются текстовым анализатором: в репозитории " +
        "hollow есть конфигурации проектов, но ни одна программа не " +
        "собралась непустой",
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("та же причина у deno-конфигурации и у адреса", () => {
  let temp: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  it("deno.json без единого исходника", async () => {
    // Второй путь к пустому составу структурно отдельный: у deno
    // состав снимается обходом дерева, а не разбором `include`.
    const repo = await hollowRepo(`${temp}/deno`, "deno");
    const result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    expect(result.sections.length).toBe(1);
    const section = result.sections[0];
    expect(section.kind, JSON.stringify(section)).toBe("refused");
    if (section.kind !== "refused") throw new Error("раздел не отказал");
    expect(section.refusal).toStrictEqual(
      "объявления не разбираются текстовым анализатором: в репозитории " +
        "hollow есть конфигурации проектов, но ни одна программа не " +
        "собралась непустой",
    );
  });

  it("адрес символа получает ту же причину", async () => {
    // `refs`/`twins` открывают анализатор другим входом, и до этой
    // порции он отвечал «файл не входит ни в один проект» — причина
    // не та: программ здесь не построилось вовсе.
    const repo = await hollowRepo(`${temp}/addr`, "tsconfig");
    await writeFile(`${repo.root}/lonely.ts`, "export const a = 1;\n");
    const result = await runRefs(
      { address: "hollow:lonely.ts:1", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    const section = result.section;
    expect(section.kind, JSON.stringify(section)).toBe("refused");
    if (section.kind !== "refused") throw new Error("раздел не отказал");
    expect(section.refusal).toStrictEqual(
      "объявления не разбираются текстовым анализатором: в репозитории " +
        "hollow есть конфигурации проектов, но ни одна программа не " +
        "собралась непустой",
    );
  });
});

it("одна конфигурация пуста, другая собралась — репозиторий отвечает", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Граница отказа — «не собралось НИ ОДНОЙ», а не «какая-то не
    // собралась»: соседний рабочий проект лёг бы вместе с пустой
    // конфигурацией.
    const root = `${temp}/mixed`;
    await mkdir(`${root}/empty/src`, { recursive: true });
    await mkdir(`${root}/works/src`, { recursive: true });
    const config =
      '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src/**/*"]}\n';
    await writeFile(`${root}/empty/tsconfig.json`, config);
    await writeFile(`${root}/works/tsconfig.json`, config);
    await writeFile(
      `${root}/works/src/a.ts`,
      "export function alpha(): number {\n  return 1;\n}\n",
    );
    const repo: Repo = {
      name: "mixed",
      root,
      mark: () =>
        Promise.resolve({ repo: "mixed", state: { kind: "out-of-git" } }),
    };
    const result = await runName(
      { name: "alpha", in: undefined, limit: 200 },
      { cwd: () => root },
      [repo],
    );
    const section = result.sections[0];
    expect(section.kind, JSON.stringify(section)).toBe("answer");
    if (section.kind !== "answer") throw new Error("раздел отказал");
    expect(section.declarations.total).toBe(1);
  } finally {
    await rm(temp, { recursive: true });
  }
});
