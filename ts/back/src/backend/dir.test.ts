/**
 * Каталог — у строки, а не у процесса (`platform/line-concurrency.md`):
 * две одновременные строки с разными каталогами видят каждая свой, а
 * каталог процесса не меняется ни разу.
 *
 * Эталон — прогон настоящих команд: `mpu code refs` спрашивает свой
 * рабочий каталог и называет его в отказе, `mpu log --file` читает файл
 * по относительному пути, `mpu xlsx alias add` пишет в кэш-БД.
 */

import { GRAMMAR } from "@mpu/language/messages";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openCacheDb } from "../store/mod.ts";
import { Client, type Frame, type TestBack, withBack } from "./testback.ts";

/** Строка с собственным каталогом; кадры — до `exit`. */
async function lineIn(
  back: TestBack,
  cwd: string,
  words: readonly string[],
  answers: readonly string[] = [],
): Promise<Frame[]> {
  const client = new Client(back, "/line", { answers });
  await client.opened();
  client.send({ words, cwd, human: true });
  return await client.finished();
}

/** Две строки разом; обе доходят до конца. */
function bothIn(back: TestBack, first: Line, second: Line): Promise<Frame[][]> {
  return Promise.all([
    lineIn(back, first.cwd, first.words, first.answers),
    lineIn(back, second.cwd, second.words, second.answers),
  ]);
}

/** Строка теста: где, какая и чем отвечать на вопрос подтверждения. */
interface Line {
  readonly cwd: string;
  readonly words: readonly string[];
  readonly answers?: readonly string[];
}

/** Текст всех кадров `err` подряд. */
function stderr(frames: readonly Frame[]): string {
  return frames.map((frame) => frame.err ?? "").join("");
}

it("рабочий каталог команды — каталог её строки", async () => {
  const a = await mkdtemp(join(tmpdir(), "mpu-"));
  const b = await mkdtemp(join(tmpdir(), "mpu-"));
  const before = process.cwd();
  try {
    await withBack(async (back) => {
      // `code refs` без имени репозитория ищет его от своего рабочего
      // каталога и называет каталог в отказе — по нему и видно, чей он.
      const [first, second] = await bothIn(
        back,
        { cwd: a, words: ["code", "refs", "address:", "чегоТоНет"] },
        { cwd: b, words: ["code", "refs", "address:", "чегоТоНет"] },
      );
      // Каталог назван в отказе дословно — по нему и видно, чей он.
      expect(stderr(first)).toContain(`нет ни у одного предка ${a}\n`);
      expect(stderr(second)).toContain(`нет ни у одного предка ${b}\n`);
    });
    // Каталог процесса не менялся: строки его не трогают.
    expect(process.cwd()).toStrictEqual(before);
  } finally {
    await rm(a, { recursive: true });
    await rm(b, { recursive: true });
  }
});

/** Одна запись журнала в формате, который читает `mpu log`. */
function record(text: string): string {
  return (
    `### 2026-09-21 10:00:00.000 +03:00 run=20260921-100000.000-1 ` +
    `pid=1 cwd=/где-то\n$ mpu ${text}\n` +
    `--- end run=20260921-100000.000-1 exit=0 dur=0.001s ---\n\n`
  );
}

it("относительный путь разрешается от каталога строки", async () => {
  const a = await mkdtemp(join(tmpdir(), "mpu-"));
  const b = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await writeFile(`${a}/свой.log`, record("строка из A"));
    await writeFile(`${b}/свой.log`, record("строка из B"));
    await withBack(
      async (back) => {
        const words = ["log", "file:", "свой.log"];
        const [first, second] = await bothIn(
          back,
          { cwd: a, words },
          { cwd: b, words },
        );
        const out = (frames: readonly Frame[]) =>
          frames.map((frame) => frame.out ?? "").join("");
        expect(out(first)).toContain("mpu строка из A");
        expect(out(second)).toContain("mpu строка из B");
        expect(first.at(-1)).toStrictEqual({ exit: 0 });
        expect(second.at(-1)).toStrictEqual({ exit: 0 });
      },
      { io: { readTextFile: (path: string) => readFile(path, "utf8") } },
    );
  } finally {
    await rm(a, { recursive: true });
    await rm(b, { recursive: true });
  }
});

it("голден: кадры двух одновременных строк с разными каталогами", async () => {
  const a = await mkdtemp(join(tmpdir(), "mpu-"));
  const b = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await withBack(async (back) => {
      const [first, second] = await bothIn(
        back,
        { cwd: a, words: ["code", "refs", "address:", "чегоТоНет"] },
        { cwd: b, words: ["version"] },
      );
      const snapshot = {
        описание: "две одновременные строки с разными каталогами",
        строки: [
          {
            cwd: MASK,
            words: ["code", "refs", "address:", "чегоТоНет"],
            кадры: masked(first, a),
          },
          { cwd: MASK, words: ["version"], кадры: masked(second, b) },
        ],
      };
      const golden = new URL(
        "testdata/line-concurrency/frames-parallel.json",
        import.meta.url,
      );
      expect(snapshot).toStrictEqual(
        JSON.parse(await readFile(golden, "utf8")),
      );
    });
  } finally {
    await rm(a, { recursive: true });
    await rm(b, { recursive: true });
  }
});

/** Каталог строки в голдене: у прогона он свой на каждой машине. */
const MASK = "<каталог строки>";

/** Кадры с подставленным вместо каталога маркером. */
function masked(frames: readonly Frame[], dir: string): Frame[] {
  return frames.map(
    (frame) => JSON.parse(JSON.stringify(frame).replaceAll(dir, MASK)) as Frame,
  );
}

it("запись журнала называет каталог своей строки", async () => {
  const a = await mkdtemp(join(tmpdir(), "mpu-"));
  const b = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await withBack(async (back) => {
      await bothIn(
        back,
        { cwd: a, words: ["version"] },
        { cwd: b, words: ["version"] },
      );
      // Каталоги записей — те самые, что пришли кадрами, по одному на
      // строку; порядок между одновременными строками не задан.
      expect([...back.dirs].sort()).toStrictEqual([a, b].sort());
    });
  } finally {
    await rm(a, { recursive: true });
    await rm(b, { recursive: true });
  }
});

it("две строки пишут в кэш-БД разом — доходят обе записи", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await withBack(
      async (back) => {
        const [first, second] = await bothIn(
          back,
          // Запись в кэш-БД — мутирующая команда: посев даёт ей `ask`,
          // и человек отвечает «да».
          {
            cwd: dir,
            words: [
              "ask",
              "xlsx",
              "alias",
              "add",
              "name:",
              "pervyi",
              "path:",
              "/1.xlsx",
            ],
            answers: ["y"],
          },
          {
            cwd: dir,
            words: [
              "ask",
              "xlsx",
              "alias",
              "add",
              "name:",
              "vtoroi",
              "path:",
              "/2.xlsx",
            ],
            answers: ["y"],
          },
        );
        expect(first.at(-1)).toStrictEqual({ exit: 0 });
        expect(second.at(-1)).toStrictEqual({ exit: 0 });
        const listed = await lineIn(back, dir, [
          "xlsx",
          "alias",
          "ls",
          GRAMMAR.close,
          "json",
        ]);
        const text = listed.map((frame) => frame.out ?? "").join("");
        expect(text).toContain("pervyi");
        expect(text).toContain("vtoroi");
        // Кэш-БД настоящая: очереди строк больше нет, и записи идут в
        // один файл одновременно (`platform/line-concurrency.md`).
      },
      { io: { openCacheDb: () => openCacheDb(`${dir}/mpu.db`) } },
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
