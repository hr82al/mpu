/**
 * Каталог — у строки, а не у процесса (`platform/line-concurrency.md`):
 * две одновременные строки с разными каталогами видят каждая свой, а
 * каталог процесса не меняется ни разу.
 *
 * Эталон — прогон настоящих команд: `mpu code refs` спрашивает свой
 * рабочий каталог и называет его в отказе, `mpu log --file` читает файл
 * по относительному пути, `mpu xlsx alias add` пишет в кэш-БД.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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
function bothIn(
  back: TestBack,
  first: Line,
  second: Line,
): Promise<Frame[][]> {
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

Deno.test("рабочий каталог команды — каталог её строки", async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  const before = Deno.cwd();
  try {
    await withBack(async (back) => {
      // `code refs` без имени репозитория ищет его от своего рабочего
      // каталога и называет каталог в отказе — по нему и видно, чей он.
      const [first, second] = await bothIn(
        back,
        { cwd: a, words: ["code", "refs", "чегоТоНет"] },
        { cwd: b, words: ["code", "refs", "чегоТоНет"] },
      );
      // Каталог назван в отказе дословно — по нему и видно, чей он.
      assertStringIncludes(stderr(first), `нет ни у одного предка ${a}\n`);
      assertStringIncludes(stderr(second), `нет ни у одного предка ${b}\n`);
    });
    // Каталог процесса не менялся: строки его не трогают.
    assertEquals(Deno.cwd(), before);
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

/** Одна запись журнала в формате, который читает `mpu log`. */
function record(text: string): string {
  return `### 2026-09-21 10:00:00.000 +03:00 run=20260921-100000.000-1 ` +
    `pid=1 cwd=/где-то\n$ mpu ${text}\n` +
    `--- end run=20260921-100000.000-1 exit=0 dur=0.001s ---\n\n`;
}

Deno.test("относительный путь разрешается от каталога строки", async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${a}/свой.log`, record("строка из A"));
    await Deno.writeTextFile(`${b}/свой.log`, record("строка из B"));
    await withBack(async (back) => {
      const words = ["log", "--file", "свой.log"];
      const [first, second] = await bothIn(
        back,
        { cwd: a, words },
        { cwd: b, words },
      );
      const out = (frames: readonly Frame[]) =>
        frames.map((frame) => frame.out ?? "").join("");
      assertStringIncludes(out(first), "mpu строка из A");
      assertStringIncludes(out(second), "mpu строка из B");
      assertEquals(first.at(-1), { exit: 0 });
      assertEquals(second.at(-1), { exit: 0 });
    }, { io: { readTextFile: (path: string) => Deno.readTextFile(path) } });
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("голден: кадры двух одновременных строк с разными каталогами", async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await withBack(async (back) => {
      const [first, second] = await bothIn(
        back,
        { cwd: a, words: ["code", "refs", "чегоТоНет"] },
        { cwd: b, words: ["version"] },
      );
      const snapshot = {
        "описание": "две одновременные строки с разными каталогами",
        "строки": [
          {
            cwd: MASK,
            words: ["code", "refs", "чегоТоНет"],
            "кадры": masked(first, a),
          },
          { cwd: MASK, words: ["version"], "кадры": masked(second, b) },
        ],
      };
      const golden = new URL(
        "testdata/line-concurrency/frames-parallel.json",
        import.meta.url,
      );
      assertEquals(snapshot, JSON.parse(await Deno.readTextFile(golden)));
    });
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

/** Каталог строки в голдене: у прогона он свой на каждой машине. */
const MASK = "<каталог строки>";

/** Кадры с подставленным вместо каталога маркером. */
function masked(frames: readonly Frame[], dir: string): Frame[] {
  return frames.map((frame) =>
    JSON.parse(JSON.stringify(frame).replaceAll(dir, MASK)) as Frame
  );
}

Deno.test("запись журнала называет каталог своей строки", async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await withBack(async (back) => {
      await bothIn(
        back,
        { cwd: a, words: ["version"] },
        { cwd: b, words: ["version"] },
      );
      // Каталоги записей — те самые, что пришли кадрами, по одному на
      // строку; порядок между одновременными строками не задан.
      assertEquals([...back.dirs].sort(), [a, b].sort());
    });
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("две строки пишут в кэш-БД разом — доходят обе записи", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withBack(async (back) => {
      const [first, second] = await bothIn(
        back,
        // Запись в кэш-БД — мутирующая команда: посев даёт ей `ask`,
        // и человек отвечает «да».
        {
          cwd: dir,
          words: ["xlsx", "alias", "add", "pervyi", "/1.xlsx"],
          answers: ["y"],
        },
        {
          cwd: dir,
          words: ["xlsx", "alias", "add", "vtoroi", "/2.xlsx"],
          answers: ["y"],
        },
      );
      assertEquals(first.at(-1), { exit: 0 });
      assertEquals(second.at(-1), { exit: 0 });
      const listed = await lineIn(back, dir, ["xlsx", "alias", "ls", "--json"]);
      const text = listed.map((frame) => frame.out ?? "").join("");
      assertStringIncludes(text, "pervyi");
      assertStringIncludes(text, "vtoroi");
      // Кэш-БД настоящая: очереди строк больше нет, и записи идут в
      // один файл одновременно (`platform/line-concurrency.md`).
    }, { io: { openCacheDb: () => openCacheDb(`${dir}/mpu.db`) } });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
