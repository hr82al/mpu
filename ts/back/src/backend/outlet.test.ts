/**
 * Отдача вывода двери агента (`platform/long-output.md`, §4): до порога —
 * целиком, сверх — файлом `<каталог>/<run_id>.txt` с правами только
 * владельцу; старые файлы каталога убираются. Каталог — временный.
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileOutlet, type Spill, WHOLE } from "./outlet.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function withSpill(
  body: (spill: Spill, diagnosed: string[]) => Promise<void>,
  threshold = 16,
) {
  const root = await mkdtemp(join(tmpdir(), "mpu-"));
  const diagnosed: string[] = [];
  try {
    await body({
      dir: `${root}/mpu-out`,
      threshold,
      now: () => Date.now(),
      diagnose: (line) => void diagnosed.push(line),
    }, diagnosed);
  } finally {
    await rm(root, { recursive: true });
  }
}

const RUN = { runId: "20260923-120000.000-7", sliced: true };

it("до порога — целиком, файла нет", () =>
  withSpill(async (spill) => {
    const outlet = new FileOutlet(spill, RUN);
    expect(await outlet.settle("0123456789abcdef")).toStrictEqual({
      stdout: "0123456789abcdef",
    });
    expect(await exists(spill.dir)).toBe(false);
  }));

it("сверх порога — файл побайтово, 0600 в каталоге 0700", () =>
  withSpill(async (spill) => {
    const stdout = "первая\nвторая\nхвост";
    const settled = await new FileOutlet(spill, RUN).settle(stdout);
    const path = `${spill.dir}/${RUN.runId}.txt`;
    const bytes = new TextEncoder().encode(stdout).byteLength;
    expect(settled).toStrictEqual({
      file: { path, bytes, lines: 3, slice: true },
    });
    expect(await readFile(path, "utf8")).toStrictEqual(stdout);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(spill.dir)).mode & 0o777).toBe(0o700);
  }));

it("порог — в байтах UTF-8, а не в символах", () =>
  withSpill(async (spill) => {
    // 10 символов, 20 байт: порог 16 байт пройден.
    const settled = await new FileOutlet(spill, RUN).settle("ёёёёёёёёёё");
    expect("file" in settled).toBe(true);
  }));

describe("строки: переводы строки и хвост без перевода", () => {
  const cases: readonly (readonly [string, number])[] = [
    ["a\nb\nc\n".repeat(10), 30],
    ["a\nb\nc".padEnd(40, "x"), 3],
    ["x".repeat(40), 1],
  ];
  for (const [stdout, lines] of cases) {
    it(`${lines}`, () =>
      withSpill(async (spill) => {
        const settled = await new FileOutlet(spill, RUN).settle(stdout);
        expect("file" in settled && settled.file.lines).toStrictEqual(lines);
      }));
  }
});

it("не коллекция — slice false", () =>
  withSpill(async (spill) => {
    const run = { ...RUN, sliced: false };
    const settled = await new FileOutlet(spill, run).settle("x".repeat(40));
    expect("file" in settled && settled.file.slice).toBe(false);
  }));

it("каталог шире 0700 — права сужаются", () =>
  withSpill(async (spill) => {
    await mkdir(spill.dir);
    await chmod(spill.dir, 0o755);
    await new FileOutlet(spill, RUN).settle("x".repeat(40));
    expect((await stat(spill.dir)).mode & 0o777).toBe(0o700);
  }));

it("файлы старше суток убираются при записи, свежие — нет", () =>
  withSpill(async (spill) => {
    await mkdir(spill.dir);
    const old = `${spill.dir}/old.txt`;
    const fresh = `${spill.dir}/fresh.txt`;
    await writeFile(old, "старое");
    await writeFile(fresh, "свежее");
    const longAgo = new Date(Date.now() - DAY_MS - 60_000);
    await utimes(old, longAgo, longAgo);
    await new FileOutlet(spill, RUN).settle("x".repeat(40));
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  }));

it("файл не записан — целиком и строка в диагностику", () =>
  withSpill(async (spill, diagnosed) => {
    // На месте каталога — файл: писать некуда.
    await writeFile(spill.dir, "не каталог");
    const stdout = "x".repeat(40);
    expect(await new FileOutlet(spill, RUN).settle(stdout)).toStrictEqual({
      stdout,
    });
    expect(diagnosed.length).toBe(1);
    expect(
      diagnosed[0].startsWith(`mpu-back: вывод не записан в ${spill.dir}/`),
    ).toBe(true);
  }));

it("WHOLE — всегда целиком", async () => {
  const stdout = "x".repeat(100_000);
  expect(await WHOLE.settle(stdout)).toStrictEqual({ stdout });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return false;
    throw err;
  }
}
