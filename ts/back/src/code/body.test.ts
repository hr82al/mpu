/**
 * Нормализация тел на формах, которых нет в дереве-фикстуре
 * (`specs/code-twins.md`, «Ввод/вывод»).
 *
 * Каждый случай здесь — про то, что нормализация стирает ровно четыре
 * различия и ни одним больше: лишнее стирание сближает тела, которые
 * делают разное, а это ложный ответ под шапкой «ответ полон».
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { UsageError } from "../command/mod.ts";
import { renderTwins, runTwins } from "./cmd_twins.ts";
import type { Repo } from "./workspace.ts";

const PROJECT = '{"compilerOptions":{"strict":true,"noEmit":true},' +
  '"include":["src/**/*"]}\n';

/** Репозиторий из одного файла с проектом. */
async function repoWith(root: string, source: string): Promise<Repo> {
  await mkdir(`${root}/src`, { recursive: true });
  await writeFile(`${root}/tsconfig.json`, PROJECT);
  await writeFile(`${root}/src/a.ts`, source);
  return {
    name: "r",
    root,
    mark: () => Promise.resolve({ repo: "r", state: { kind: "out-of-git" } }),
  };
}

async function twins(repo: Repo, address: string): Promise<string> {
  return renderTwins(
    await runTwins({ address, limit: 200 }, { cwd: () => repo.root }, [repo]),
  );
}

it("тела, расходящиеся после шаблонного литерала, близнецами не считаются", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Сканер текста после `${…}` считает закрывающий апостроф началом
    // нового литерала и съедает весь хвост тела: два этих тела он
    // сводил бы к одной нормальной форме.
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export function head(day: string): string {",
        "  const s = `${day}T00:00`;",
        '  return s + "первый хвост";',
        "}",
        "",
        "export function tail(day: string): string {",
        "  const s = `${day}T00:00`;",
        '  return s + "второй хвост" + "и ещё кусок";',
        "}",
        "",
      ].join("\n"),
    );
    const text = await twins(repo, "r:src/a.ts:1");
    expect(text.includes("побайтово: 1"), text).toBe(true);
    expect(text.includes("похоже: 0"), text).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("имя свойства не переименовывается вместе с локальным", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Тела различаются ровно именем читаемого поля. Переименуй мы
    // имена свойств наравне с локальными — оба стали бы «имя1 . имя2 +
    // лит1», то есть одним телом; спасает то, что локальность
    // определяется по месту объявления символа, а поле объявлено вне
    // функции.
    const repo = await repoWith(
      `${temp}/r`,
      [
        "type Box = { alpha: number; beta: number };",
        "",
        "export function first(box: Box): number {",
        "  return box.alpha + 1;",
        "}",
        "",
        "export function second(box: Box): number {",
        "  return box.beta + 1;",
        "}",
        "",
      ].join("\n"),
    );
    const text = await twins(repo, "r:src/a.ts:3");
    expect(text.includes("побайтово: 1"), text).toBe(true);
    expect(text.includes("похоже: 0"), text).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("переименование параметров и литералы тела сближают", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export function one(from: string): string {",
        '  const mark = "первый";',
        "  return from + mark;",
        "}",
        "",
        "export function two(to: string): string {",
        '  const label = "второй";',
        "  return to + label;",
        "}",
        "",
      ].join("\n"),
    );
    const text = await twins(repo, "r:src/a.ts:1");
    expect(text.includes("похоже: 1"), text).toBe(true);
    expect(text.includes("  src/a.ts:6  two"), text).toBe(true);
    expect(
      text.includes(
        '    разница: литерал "первый" против "второй"; имена различаются',
      ),
      text,
    ).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("строка внутри многострочной сигнатуры покрыта объявлением", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export function wide(",
        "  a: string,",
        "  b: string,",
        "): string {",
        "  const c = a + b;",
        "  return c;",
        "}",
        "",
      ].join("\n"),
    );
    // Шестая строка — внутри тела; охват считается по концу тела, а не
    // по длине его текста от строки объявления.
    const text = await twins(repo, "r:src/a.ts:6");
    expect(text.includes("wide (a: string, b: string): string"), text).toBe(
      true,
    );
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("объявление без тела — свой отказ, а не «нет объявления-функции»", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export declare function outside(day: string): string;",
        "",
        "export function inside(day: string): string {",
        "  return day;",
        "}",
        "",
      ].join("\n"),
    );
    const err = await rejected(() => twins(repo, "r:src/a.ts:1"), UsageError);
    expect(err.message).toBe("у объявления в строке 1 нет тела");
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("док-комментарий снимается наравне с обычным", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // `//` и `/* */` — тривия, а `/** */` — узел дерева: без явного
    // снятия он уезжал бы в нормальную форму, и тела, различающиеся
    // только им, переставали быть похожими.
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export function first(day: string): string {",
        "  /** Зачем это здесь. */",
        "  const kept = day;",
        "  return kept;",
        "}",
        "",
        "export function second(day: string): string {",
        "  const kept = day;",
        "  return kept;",
        "}",
        "",
      ].join("\n"),
    );
    const text = await twins(repo, "r:src/a.ts:1");
    expect(text.includes("похоже: 1"), text).toBe(true);
    expect(text.includes("    разница: комментарий снят"), text).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("текст внутри шаблона — литерал, а не различие тел", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Пара к правилу «литералы заменены позиционными метками»: тела
    // совпадают во всём, кроме текста внутри шаблона, и обязаны быть
    // похожими с названной разницей.
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export function first(day: string): string {",
        "  return `${day}T00:00`;",
        "}",
        "",
        "export function second(day: string): string {",
        "  return `${day}T12:00`;",
        "}",
        "",
      ].join("\n"),
    );
    const text = await twins(repo, "r:src/a.ts:1");
    expect(text.includes("похоже: 1"), text).toBe(true);
    expect(text.includes("разница: литерал"), text).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("строка с объявлением-не-функцией даёт перечень объявлений", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Отказ «нет тела» — только про объявление-функцию: промахнувшийся
    // строкой читатель обязан получить перечень, по которому выберет
    // верную.
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export const LIMIT = 1;",
        "",
        "export function only(day: string): string {",
        "  return day;",
        "}",
        "",
      ].join("\n"),
    );
    const err = await rejected(() => twins(repo, "r:src/a.ts:1"), UsageError);
    expect(err.message).toBe("в строке 1 нет объявления-функции");
    expect(err.details).toBe("  src/a.ts:1  LIMIT\n  src/a.ts:3  only");
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("расхождение одними пробелами — установленная разница", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Ни комментарии, ни литералы, ни имена не разошлись, а тексты не
    // равны: это вёрстка, и она известна. Назвать её «не установлена»
    // значило бы выдать незнание за ответ.
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export function tight(n: number): number {",
        "  const doubled = n * 2;",
        "  return doubled;",
        "}",
        "",
        "export function loose(n: number): number {",
        "  const doubled = n *",
        "    2;",
        "  return doubled;",
        "}",
        "",
      ].join("\n"),
    );
    const text = await twins(repo, "r:src/a.ts:1");
    expect(text.includes("похоже: 1"), text).toBe(true);
    expect(text.includes("    разница: форматирование"), text).toBe(true);
  } finally {
    await rm(temp, { recursive: true });
  }
});

it("пробелы внутри литерала — расхождение литералов, а не вёрстки", async () => {
  const temp = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    // Снятие всех пробелов делает тексты равными, но различие тел
    // названо литералом и названо один раз: приписать сюда ещё и
    // «форматирование» значило бы назвать одно различие дважды.
    const repo = await repoWith(
      `${temp}/r`,
      [
        "export function tight(): string {",
        '  return "a  b";',
        "}",
        "",
        "export function loose(): string {",
        '  return "a b";',
        "}",
        "",
      ].join("\n"),
    );
    const text = await twins(repo, "r:src/a.ts:1");
    expect(text.includes("похоже: 1"), text).toBe(true);
    expect(text.includes('разница: литерал "a  b" против "a b"'), text).toBe(
      true,
    );
    expect(text.includes("форматирование"), text).toBe(false);
  } finally {
    await rm(temp, { recursive: true });
  }
});
