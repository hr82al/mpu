/**
 * `mpu code refs` против golden-эталонов спеки (`specs/code-refs.md`).
 *
 * Дерево-фикстура материализуется во временный каталог с именем
 * `fixture`: имя репозитория в голденах именно это, и от имени
 * временного каталога зависеть не должно. Расширение `.txt` снимается
 * при материализации — файлы `.ts` в канале спецификаций попали бы под
 * гейты модуля.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import { UsageError } from "../command/mod.ts";
import { renderRefs, runRefs } from "./cmd_refs.ts";
import { openFixture } from "./testing.ts";
import type { Repo } from "./workspace.ts";

/** Прогон команды на фикстуре: рабочий каталог — корень репозитория. */
async function refs(
  repo: Repo,
  address: string,
  limit = 200,
): Promise<string> {
  const result = await runRefs({ address, limit }, { cwd: () => repo.root }, [
    repo,
  ]);
  return renderRefs(result);
}

async function golden(name: string): Promise<string> {
  return await readFile(
    new URL(`testdata/code/${name}`, import.meta.url),
    "utf8",
  );
}

describe("refs на дереве-фикстуре совпадает с голденами спеки", () => {
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
    ["fixture:src/days.ts:2", "refs-symbol.stdout.txt"],
    ["fixture:src/window.ts", "refs-module.stdout.txt"],
    ["fixture:src/orphan.ts:2", "refs-orphan.stdout.txt"],
  ];
  for (const [address, name] of cases) {
    it(name, async () => {
      expect(await refs(repo, address)).toStrictEqual(await golden(name));
    });
  }
});

it("два вызова на неизменном дереве дают один и тот же текст", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openFixture(temp);
    const first = await refs(repo, "fixture:src/days.ts:2");
    expect(await refs(repo, "fixture:src/days.ts:2")).toStrictEqual(first);
  } finally {
    await rm(temp, { recursive: true });
  }
});

describe("отметка дерева под git печатается обоими видами", () => {
  let temp: string;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  const cases: readonly (readonly [string, boolean, string])[] = [
    ["чистое дерево", false, "дерево чистое"],
    ["с изменениями", true, "дерево содержит незакоммиченные изменения"],
  ];
  for (const [title, dirty, state] of cases) {
    it(title, async () => {
      const repo = await openFixture(`${temp}/${dirty}`, {
        repo: "fixture",
        state: {
          kind: "git",
          branch: "feat/checklist/serving/screen-data-endpoint",
          commit: "989c0bf9",
          dirty,
        },
      });
      const text = await refs(repo, "fixture:src/days.ts:2");
      expect(text.split("\n")[0]).toStrictEqual(
        `fixture · feat/checklist/serving/screen-data-endpoint · 989c0bf9 · ${state} · разбор по типам — ответ полон`,
      );
    });
  }
});

describe("ошибки ввода: репозиторий, файл, строка без объявления", () => {
  let temp: string;
  let repo: Repo;
  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "mpu-"));
    repo = await openFixture(temp);
  });
  afterAll(async () => {
    await rm(temp, { recursive: true });
  });
  it("неизвестный репозиторий", async () => {
    const err = await refs(repo, "nope:src/days.ts:2").catch((
      thrown: unknown,
    ) => thrown);
    assert(err instanceof UsageError);
    expect(err.message).toBe("неизвестный репозиторий 'nope'");
    expect(err.details).toBe("  fixture");
  });
  it("файла нет", async () => {
    const err = await refs(repo, "fixture:src/gone.ts").catch((
      thrown: unknown,
    ) => thrown);
    assert(err instanceof UsageError);
    expect(err.message).toBe("файла src/gone.ts нет в fixture на вне git");
  });
  it("в строке нет объявления", async () => {
    const err = await refs(repo, "fixture:src/days.ts:1").catch((
      thrown: unknown,
    ) => thrown);
    assert(err instanceof UsageError);
    expect(err.message).toBe("в строке 1 нет объявления");
    expect(err.details).toBe(
      "  src/days.ts:2  addDays\n  src/days.ts:9  spanDays",
    );
  });
});

it("усечение — не ошибка: раздел говорит о нём сам", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await openFixture(temp);
    const text = await refs(repo, "fixture:src/days.ts:2", 2);
    expect(text.includes("потребители: 7 файлов"), text).toBe(true);
    expect(text.includes("  усечено: показано 2 из 7"), text).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});
