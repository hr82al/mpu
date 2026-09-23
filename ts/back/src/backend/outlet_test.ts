/**
 * Отдача вывода двери агента (`platform/long-output.md`, §4): до порога —
 * целиком, сверх — файлом `<каталог>/<run_id>.txt` с правами только
 * владельцу; старые файлы каталога убираются. Каталог — временный.
 */

import { assertEquals } from "@std/assert";
import { FileOutlet, type Spill, WHOLE } from "./outlet.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function withSpill(
  body: (spill: Spill, diagnosed: string[]) => Promise<void>,
  threshold = 16,
) {
  const root = await Deno.makeTempDir();
  const diagnosed: string[] = [];
  try {
    await body({
      dir: `${root}/mpu-out`,
      threshold,
      now: () => Date.now(),
      diagnose: (line) => void diagnosed.push(line),
    }, diagnosed);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const RUN = { runId: "20260923-120000.000-7", sliced: true };

Deno.test("до порога — целиком, файла нет", () =>
  withSpill(async (spill) => {
    const outlet = new FileOutlet(spill, RUN);
    assertEquals(await outlet.settle("0123456789abcdef"), {
      stdout: "0123456789abcdef",
    });
    assertEquals(await exists(spill.dir), false);
  }));

Deno.test("сверх порога — файл побайтово, 0600 в каталоге 0700", () =>
  withSpill(async (spill) => {
    const stdout = "первая\nвторая\nхвост";
    const settled = await new FileOutlet(spill, RUN).settle(stdout);
    const path = `${spill.dir}/${RUN.runId}.txt`;
    const bytes = new TextEncoder().encode(stdout).byteLength;
    assertEquals(settled, { file: { path, bytes, lines: 3, slice: true } });
    assertEquals(await Deno.readTextFile(path), stdout);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(spill.dir)).mode! & 0o777, 0o700);
  }));

Deno.test("порог — в байтах UTF-8, а не в символах", () =>
  withSpill(async (spill) => {
    // 10 символов, 20 байт: порог 16 байт пройден.
    const settled = await new FileOutlet(spill, RUN).settle("ёёёёёёёёёё");
    assertEquals("file" in settled, true);
  }));

Deno.test("строки: переводы строки и хвост без перевода", async (t) => {
  const cases: readonly (readonly [string, number])[] = [
    ["a\nb\nc\n".repeat(10), 30],
    ["a\nb\nc".padEnd(40, "x"), 3],
    ["x".repeat(40), 1],
  ];
  for (const [stdout, lines] of cases) {
    await t.step(`${lines}`, () =>
      withSpill(async (spill) => {
        const settled = await new FileOutlet(spill, RUN).settle(stdout);
        assertEquals("file" in settled && settled.file.lines, lines);
      }));
  }
});

Deno.test("не коллекция — slice false", () =>
  withSpill(async (spill) => {
    const run = { ...RUN, sliced: false };
    const settled = await new FileOutlet(spill, run).settle("x".repeat(40));
    assertEquals("file" in settled && settled.file.slice, false);
  }));

Deno.test("каталог шире 0700 — права сужаются", () =>
  withSpill(async (spill) => {
    await Deno.mkdir(spill.dir);
    await Deno.chmod(spill.dir, 0o755);
    await new FileOutlet(spill, RUN).settle("x".repeat(40));
    assertEquals((await Deno.stat(spill.dir)).mode! & 0o777, 0o700);
  }));

Deno.test("файлы старше суток убираются при записи, свежие — нет", () =>
  withSpill(async (spill) => {
    await Deno.mkdir(spill.dir);
    const old = `${spill.dir}/old.txt`;
    const fresh = `${spill.dir}/fresh.txt`;
    await Deno.writeTextFile(old, "старое");
    await Deno.writeTextFile(fresh, "свежее");
    const longAgo = new Date(Date.now() - DAY_MS - 60_000);
    await Deno.utime(old, longAgo, longAgo);
    await new FileOutlet(spill, RUN).settle("x".repeat(40));
    assertEquals(await exists(old), false);
    assertEquals(await exists(fresh), true);
  }));

Deno.test("файл не записан — целиком и строка в диагностику", () =>
  withSpill(async (spill, diagnosed) => {
    // На месте каталога — файл: писать некуда.
    await Deno.writeTextFile(spill.dir, "не каталог");
    const stdout = "x".repeat(40);
    assertEquals(await new FileOutlet(spill, RUN).settle(stdout), { stdout });
    assertEquals(diagnosed.length, 1);
    assertEquals(
      diagnosed[0].startsWith(`mpu-back: вывод не записан в ${spill.dir}/`),
      true,
    );
  }));

Deno.test("WHOLE — всегда целиком", async () => {
  const stdout = "x".repeat(100_000);
  assertEquals(await WHOLE.settle(stdout), { stdout });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}
