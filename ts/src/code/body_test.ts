/**
 * Нормализация тел на формах, которых нет в дереве-фикстуре
 * (`specs/code-twins.md`, «Ввод/вывод»).
 *
 * Каждый случай здесь — про то, что нормализация стирает ровно четыре
 * различия и ни одним больше: лишнее стирание сближает тела, которые
 * делают разное, а это ложный ответ под шапкой «ответ полон».
 */

import { assertEquals, assertRejects } from "@std/assert";
import { UsageError } from "../command/mod.ts";
import { renderTwins, runTwins } from "./cmd_twins.ts";
import type { Repo } from "./workspace.ts";

const PROJECT = '{"compilerOptions":{"strict":true,"noEmit":true},' +
  '"include":["src/**/*"]}\n';

/** Репозиторий из одного файла с проектом. */
async function repoWith(root: string, source: string): Promise<Repo> {
  await Deno.mkdir(`${root}/src`, { recursive: true });
  await Deno.writeTextFile(`${root}/tsconfig.json`, PROJECT);
  await Deno.writeTextFile(`${root}/src/a.ts`, source);
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

Deno.test("тела, расходящиеся после шаблонного литерала, близнецами не считаются", async () => {
  const temp = await Deno.makeTempDir();
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
    assertEquals(text.includes("побайтово: 1"), true, text);
    assertEquals(text.includes("похоже: 0"), true, text);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("имя свойства не переименовывается вместе с локальным", async () => {
  const temp = await Deno.makeTempDir();
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
    assertEquals(text.includes("побайтово: 1"), true, text);
    assertEquals(text.includes("похоже: 0"), true, text);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("переименование параметров и литералы тела сближают", async () => {
  const temp = await Deno.makeTempDir();
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
    assertEquals(text.includes("похоже: 1"), true, text);
    assertEquals(text.includes("  src/a.ts:6  two"), true, text);
    assertEquals(
      text.includes(
        '    разница: литерал "первый" против "второй"; имена различаются',
      ),
      true,
      text,
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("строка внутри многострочной сигнатуры покрыта объявлением", async () => {
  const temp = await Deno.makeTempDir();
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
    assertEquals(
      text.includes("wide (a: string, b: string): string"),
      true,
      text,
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("объявление без тела — свой отказ, а не «нет объявления-функции»", async () => {
  const temp = await Deno.makeTempDir();
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
    const err = await assertRejects(
      () => twins(repo, "r:src/a.ts:1"),
      UsageError,
    );
    assertEquals(err.message, "у объявления в строке 1 нет тела");
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("док-комментарий снимается наравне с обычным", async () => {
  const temp = await Deno.makeTempDir();
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
    assertEquals(text.includes("похоже: 1"), true, text);
    assertEquals(text.includes("    разница: комментарий снят"), true, text);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("текст внутри шаблона — литерал, а не различие тел", async () => {
  const temp = await Deno.makeTempDir();
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
    assertEquals(text.includes("похоже: 1"), true, text);
    assertEquals(text.includes("разница: литерал"), true, text);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});

Deno.test("строка с объявлением-не-функцией даёт перечень объявлений", async () => {
  const temp = await Deno.makeTempDir();
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
    const err = await assertRejects(
      () => twins(repo, "r:src/a.ts:1"),
      UsageError,
    );
    assertEquals(err.message, "в строке 1 нет объявления-функции");
    assertEquals(
      err.details,
      "  src/a.ts:1  LIMIT\n  src/a.ts:3  only",
    );
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
});
