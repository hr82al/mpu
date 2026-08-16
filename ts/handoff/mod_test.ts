import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  CellError,
  MARKER,
  parseCell,
  readCell,
  waitFor,
  writeCell,
} from "./mod.ts";

Deno.test("ячейка: вид задаёт первая строка", async (t) => {
  await t.step("маркер постановки и маркер отчёта", () => {
    assertEquals(parseCell("# ЗАДАНИЕ\n\nтекст\n").kind, "task");
    assertEquals(parseCell("# ОТЧЁТ\n\nтекст\n").kind, "report");
  });

  await t.step("маркер ниже первой строки не считается", () => {
    assertThrows(() => parseCell("предисловие\n# ЗАДАНИЕ\n"), CellError);
  });

  await t.step("пустая ячейка — своя причина, не «не маркер»", () => {
    assertThrows(
      () => parseCell("   \n"),
      CellError,
      "ячейка пуста",
    );
  });

  await t.step("число строк считается по тексту целиком", () => {
    assertEquals(parseCell("# ОТЧЁТ\n\nа\nб\n").lines, 5);
  });
});

Deno.test("ячейка: запись кладёт новое вместо старого", async (t) => {
  const dir = await Deno.makeTempDir();
  const cell = `${dir}/buf.txt`;
  try {
    await t.step("файла нет — читать нечего", async () => {
      await assertRejects(() => readCell(cell), CellError, "не передавалась");
    });

    await t.step("маркер дописывается, если его нет во входе", async () => {
      await writeCell(cell, "task", "Порция: перенос карточки.");
      const written = await readCell(cell);
      assertEquals(written.kind, "task");
      assertEquals(written.text.startsWith(`${MARKER.task}\n\n`), true);
    });

    await t.step("готовый маркер входа не дублируется", async () => {
      await writeCell(cell, "report", `${MARKER.report}\n\nготово\n`);
      assertEquals((await readCell(cell)).text, `${MARKER.report}\n\nготово\n`);
    });

    await t.step("отчёт кладётся вместо постановки, а не рядом", async () => {
      const text = (await readCell(cell)).text;
      assertEquals(text.includes(MARKER.task), false);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ячейка: ожидание нужного маркера", async (t) => {
  const dir = await Deno.makeTempDir();
  const cell = `${dir}/buf.txt`;
  try {
    await t.step("нужного вида нет — отказ по сроку", async () => {
      await writeCell(cell, "report", "отчёт");
      await assertRejects(
        () => waitFor(cell, "task", { everyMs: 5, timeoutMs: 20 }),
        CellError,
        MARKER.task,
      );
    });

    await t.step("появившаяся постановка возвращается ожидающему", async () => {
      const waiting = waitFor(cell, "task", { everyMs: 5, timeoutMs: 5000 });
      await writeCell(cell, "task", "следующая порция");
      assertEquals((await waiting).kind, "task");
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
