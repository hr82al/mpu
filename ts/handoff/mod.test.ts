import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejected, thrown } from "../back/src/testing/thrown.ts";
import {
  CellError,
  MARKER,
  parseCell,
  readCell,
  waitFor,
  writeCell,
} from "./mod.ts";

describe("ячейка: вид задаёт первая строка", () => {
  it("маркер постановки и маркер отчёта", () => {
    expect(parseCell("# ЗАДАНИЕ\n\nтекст\n").kind).toBe("task");
    expect(parseCell("# ОТЧЁТ\n\nтекст\n").kind).toBe("report");
  });

  it("маркер ниже первой строки не считается", () => {
    expect(() => parseCell("предисловие\n# ЗАДАНИЕ\n")).toThrow(CellError);
  });

  it("пустая ячейка — своя причина, не «не маркер»", () => {
    thrown(() => parseCell("   \n"), CellError, "ячейка пуста");
  });

  it("число строк считается по тексту целиком", () => {
    expect(parseCell("# ОТЧЁТ\n\nа\nб\n").lines).toBe(5);
  });
});

describe("ячейка: запись кладёт новое вместо старого", () => {
  let dir: string;
  let cell: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mpu-"));
    cell = `${dir}/buf.txt`;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true });
  });

  it("файла нет — читать нечего", async () => {
    await rejected(() => readCell(cell), CellError, "не передавалась");
  });

  it("маркер дописывается, если его нет во входе", async () => {
    await writeCell(cell, "task", "Порция: перенос карточки.");
    const written = await readCell(cell);
    expect(written.kind).toBe("task");
    expect(written.text.startsWith(`${MARKER.task}\n\n`)).toBe(true);
  });

  it("готовый маркер входа не дублируется", async () => {
    await writeCell(cell, "report", `${MARKER.report}\n\nготово\n`);
    expect((await readCell(cell)).text).toStrictEqual(
      `${MARKER.report}\n\nготово\n`,
    );
  });

  it("отчёт кладётся вместо постановки, а не рядом", async () => {
    const text = (await readCell(cell)).text;
    expect(text.includes(MARKER.task)).toBe(false);
  });
});

describe("ячейка: ожидание нужного маркера", () => {
  let dir: string;
  let cell: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mpu-"));
    cell = `${dir}/buf.txt`;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true });
  });

  it("нужного вида нет — отказ по сроку", async () => {
    await writeCell(cell, "report", "отчёт");
    await rejected(
      () => waitFor(cell, "task", { everyMs: 5, timeoutMs: 20 }),
      CellError,
      MARKER.task,
    );
  });

  it("появившаяся постановка возвращается ожидающему", async () => {
    const waiting = waitFor(cell, "task", { everyMs: 5, timeoutMs: 5000 });
    await writeCell(cell, "task", "следующая порция");
    expect((await waiting).kind).toBe("task");
  });
});
