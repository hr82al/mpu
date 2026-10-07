/**
 * `mpu code twins` против golden-эталонов спеки (`specs/code-twins.md`).
 *
 * Главное здесь — что сравниваются тела, а не имена: три побайтово
 * равных тела фикстуры носят три разных имени, и учёт имени оставил бы
 * от ответа одно совпадение из трёх.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejected } from "@mpu/testing/thrown";
import { UsageError } from "../command/mod.ts";
import { codeTwinsCommand, renderTwins, runTwins } from "./cmd_twins.ts";
import { openFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

/** Прогон команды на фикстуре: рабочий каталог — корень репозитория. */
async function twins(
  repo: Repo,
  address: string,
  limit = 200,
): Promise<string> {
  const result = await runTwins({ address, limit }, { cwd: () => repo.root }, [
    repo,
  ]);
  return renderTwins(result);
}

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`testdata/code/${name}`, import.meta.url),
    "utf8",
  );
}

describe("twins на дереве-фикстуре совпадает с голденами спеки", () => {
  let temp: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openFixture(temp);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  const cases: readonly (readonly [string, string])[] = [
    ["fixture:src/window.ts:4", "twins-exact.stdout.txt"],
    ["fixture:src/loaderA.ts:2", "twins-similar.stdout.txt"],
  ];
  for (const [address, name] of cases) {
    it(name, async () => {
      expect(await twins(repo, address)).toStrictEqual(await golden(name));
    });
  }
});

describe("тело берётся у объявления, охватывающего строку", () => {
  let temp: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openFixture(temp);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });

  it("строка внутри тела, а не строка объявления", async () => {
    // Пятая строка `window.ts` — середина тела; объявление начинается
    // четвёртой, и ответ обязан быть тем же.
    expect(await twins(repo, "fixture:src/window.ts:5")).toStrictEqual(
      await golden("twins-exact.stdout.txt"),
    );
  });

  it("строка вне всякого объявления — ошибка ввода", async () => {
    const err = await rejected(
      () => twins(repo, "fixture:src/window.ts:1"),
      UsageError,
    );
    expect(err.message).toBe("в строке 1 нет объявления-функции");
    expect(err.details).toBe("  src/window.ts:4  windowDays");
  });

  it("адрес без строки — ошибка ввода", async () => {
    const err = await rejected(
      () => twins(repo, "fixture:src/window.ts"),
      UsageError,
    );
    expect(err.message).toBe(
      "нужна строка: тело берётся у объявления, охватывающего её",
    );
  });
});

it("близнецов нет — ответ, а не отказ", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openFixture(temp);
    // `addDays` уникален в дереве: раздел «побайтово» несёт только сам
    // запрос, «похоже» пуст — и это ответ.
    const text = await twins(repo, "fixture:src/days.ts:2");
    expect(text.includes("побайтово: 1\n  src/days.ts:2  addDays"), text).toBe(
      true,
    );
    expect(text.includes("похоже: 0"), text).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("усечение — не ошибка: раздел говорит о нём сам", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openFixture(temp);
    const text = await twins(repo, "fixture:src/window.ts:4", 2);
    expect(text.includes("побайтово: 3"), text).toBe(true);
    expect(text.includes("  усечено: показано 2 из 3"), text).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("репозиторий без проектов: тела не разбираются — отказ", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const root = `${temp}/plain`;
    await mkdir(`${root}/src`, { recursive: true });
    await writeFile(
      `${root}/src/a.ts`,
      "export function one() {\n  return 1;\n}\n",
    );
    const repo: Repo = {
      name: "plain",
      root,
      mark: () =>
        Promise.resolve({ repo: "plain", state: { kind: "out-of-git" } }),
    };
    // Пустые разделы читались бы как «близнецов нет», а это другой
    // ответ: выделить тело без разбора нечем.
    const result = await runTwins(
      { address: "plain:src/a.ts:1", limit: 200 },
      { cwd: () => repo.root },
      [repo],
    );
    const section = result.section;
    expect(section.kind, JSON.stringify(section)).toBe("refused");
    if (section.kind !== "refused") throw new Error("раздел не отказал");
    expect(section.refusal).toStrictEqual(
      "тела не разбираются текстовым анализатором: " +
        "в репозитории plain нет ни одного проекта",
    );
    // Отметку дерева несёт каждый раздел, включая отказавший.
    expect(section.mark.repo).toBe("plain");
    expect(codeTwinsCommand.textExitCode(result)).toBe(1);
  } finally {
    await rm(temp, { recursive: true });
  }
});
