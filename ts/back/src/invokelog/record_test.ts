import { assertEquals, assertMatch } from "@std/assert";
import { commandLine } from "./mask.ts";
import { formatRecord, type InvokeRecordFields, runIdOf } from "./record.ts";

/** Смещение зоны, в которой сняты golden-записи: +03:00. */
const MSK = 180;

/** Поля по умолчанию: тест называет только то, что проверяет. */
function fields(patch: Partial<InvokeRecordFields> = {}): InvokeRecordFields {
  return {
    startedAt: new Date("2026-08-05T04:42:28.205Z"),
    offsetMinutes: MSK,
    pid: 396570,
    cwd: "/home/user",
    commandLine: "mpu version",
    note: "",
    out: "",
    err: "",
    exitCode: 0,
    durationMs: 371,
    maxOutputBytes: 0,
    ...patch,
  };
}

Deno.test("golden-записи собираются из полей байт-в-байт", async (t) => {
  const cases: readonly [
    name: string,
    argv: string[],
    patch: Partial<InvokeRecordFields>,
  ][] = [
    ["record-out-ok.txt", ["sql-ro", "sl-1", "SELECT 1 AS one", "--json"], {
      startedAt: new Date("2026-08-05T04:42:28.205Z"),
      pid: 396570,
      out: '[{"one": 1}]\n',
      exitCode: 0,
      durationMs: 371,
    }],
    ["record-err-ok.txt", ["sql-ro", "sl-1", "SELECT 1", "--dry"], {
      startedAt: new Date("2026-08-05T04:39:44.525Z"),
      pid: 385900,
      err: "server: sl-1\npg_host: <pg_host>\npg_port: 5432\ndatabase: wb\n" +
        "mode: read-only\nsql:\nSELECT 1\n",
      exitCode: 0,
      durationMs: 286,
    }],
    [
      "record-failed-masked.txt",
      ["sql-ro", "sl-1", "SELECT 1", "--dry", "--token=t0p"],
      {
        startedAt: new Date("2026-08-05T04:39:45.017Z"),
        pid: 385927,
        err: "Usage: mpu sql-ro [OPTIONS] {selector} [sql]\n" +
          "Try 'mpu sql-ro -h' for help.\n" +
          `╭─ Error ${"─".repeat(70)}╮\n` +
          `│ ${
            "No such option: --token (Possible options: --json)".padEnd(77)
          }│\n` +
          `╰${"─".repeat(78)}╯\n`,
        exitCode: 2,
        durationMs: 265,
      },
    ],
  ];
  for (const [name, argv, patch] of cases) {
    await t.step(name, async () => {
      const golden = await Deno.readTextFile(
        new URL(`testdata/${name}`, import.meta.url),
      );
      assertEquals(
        formatRecord(
          fields({ ...patch, cwd: "<cwd>", commandLine: commandLine(argv) }),
        ),
        golden,
      );
    });
  }
});

Deno.test("смещение зоны — со знаком и минутами", async (t) => {
  const cases: readonly [offset: number, stamp: string, runId: string][] = [
    [180, "2026-08-05 07:42:28.205 +03:00", "20260805-074228.205-1"],
    [-300, "2026-08-04 23:42:28.205 -05:00", "20260804-234228.205-1"],
    [330, "2026-08-05 10:12:28.205 +05:30", "20260805-101228.205-1"],
    [0, "2026-08-05 04:42:28.205 +00:00", "20260805-044228.205-1"],
  ];
  const at = new Date("2026-08-05T04:42:28.205Z");
  for (const [offset, stamp, id] of cases) {
    await t.step(`смещение ${offset}`, () => {
      assertEquals(runIdOf(at, offset, 1), id);
      assertMatch(
        formatRecord(fields({ startedAt: at, offsetMinutes: offset, pid: 1 })),
        new RegExp(`^### ${stamp.replaceAll(/[.+]/g, "\\$&")} run=`, "mu"),
      );
    });
  }
});

Deno.test("run_id — время начала и pid", () => {
  assertEquals(
    runIdOf(new Date("2026-08-05T04:39:45.017Z"), MSK, 385927),
    "20260805-073945.017-385927",
  );
});

Deno.test("пустая секция не печатается", async (t) => {
  await t.step("нет ни note, ни out, ни err", () => {
    assertEquals(
      formatRecord(fields()),
      "### 2026-08-05 07:42:28.205 +03:00 run=20260805-074228.205-396570" +
        " pid=396570 cwd=/home/user\n" +
        "$ mpu version\n" +
        "--- end run=20260805-074228.205-396570 exit=0 dur=0.371s ---\n\n",
    );
  });
  await t.step("порядок секций: note, out, err", () => {
    const text = formatRecord(
      fields({ note: "n\n", out: "o\n", err: "e\n" }),
    );
    const markers = text.split("\n").filter((line) => line.startsWith("---"));
    assertEquals(markers.map((line) => line.split(" ")[1]), [
      "note",
      "out",
      "err",
      "end",
    ]);
  });
});

Deno.test("вывод без завершающего перевода строки не съедает маркер", () => {
  const text = formatRecord(fields({ out: "хвост" }));
  assertMatch(text, /^хвост\n--- end /mu);
});

Deno.test("обрезка сверх предела", async (t) => {
  await t.step("маркер называет поток и число отброшенных байт", () => {
    const text = formatRecord(fields({ out: "abcdef\n", maxOutputBytes: 3 }));
    assertEquals(
      text.split("\n").slice(3, 6),
      [
        "abc",
        "--- truncated run=20260805-074228.205-396570 stream=out dropped=4 ---",
        "--- end run=20260805-074228.205-396570 exit=0 dur=0.371s ---",
      ],
    );
  });
  await t.step("неполный хвостовой UTF-8-символ дорезается", () => {
    // «ы» — два байта: предел 2 оставляет «a» и половину символа.
    const text = formatRecord(fields({ err: "aыb", maxOutputBytes: 2 }));
    assertEquals(text.split("\n").slice(3, 5), [
      "a",
      "--- truncated run=20260805-074228.205-396570 stream=err dropped=3 ---",
    ]);
  });
  await t.step("обрезка съела всё — остаётся только маркер", () => {
    const text = formatRecord(fields({ out: "ыы", maxOutputBytes: 1 }));
    assertEquals(text.includes("--- out "), false);
    assertMatch(text, /^--- truncated run=\S+ stream=out dropped=4 ---$/mu);
  });
  await t.step("настоящий символ замены на границе не съедается", () => {
    // U+FFFD печатает всякий, кто декодировал чужие байты нестрого;
    // от оборванного хвоста он отличается только положением байт.
    const text = formatRecord(
      fields({ out: "abc\uFFFDdef", maxOutputBytes: 6 }),
    );
    assertEquals(text.split("\n").slice(3, 5), [
      "abc\uFFFD",
      "--- truncated run=20260805-074228.205-396570 stream=out dropped=3 ---",
    ]);
  });
  await t.step("предел 0 — без обрезки", () => {
    const text = formatRecord(fields({ out: "abcdef\n", maxOutputBytes: 0 }));
    assertEquals(text.includes("truncated"), false);
  });
  await t.step("вывод ровно в предел не обрезается", () => {
    const text = formatRecord(fields({ out: "abc\n", maxOutputBytes: 4 }));
    assertEquals(text.includes("truncated"), false);
  });
});

Deno.test("маркеры внутри чужого вывода не рвут запись", () => {
  // Запись читается по шапке и `--- end` со своим run_id; строка вывода,
  // похожая на маркер, остаётся частью секции.
  const text = formatRecord(fields({ out: "--- end run=чужой exit=0 ---\n" }));
  assertEquals(
    text.split("\n").filter((line) => line.startsWith("--- end")),
    [
      "--- end run=чужой exit=0 ---",
      "--- end run=20260805-074228.205-396570 exit=0 dur=0.371s ---",
    ],
  );
});

Deno.test("длительность — секунды с тремя знаками", async (t) => {
  const cases: readonly [ms: number, dur: string][] = [
    [0, "0.000"],
    [7, "0.007"],
    [1500, "1.500"],
    [65_432, "65.432"],
  ];
  for (const [ms, dur] of cases) {
    await t.step(`${ms} мс`, () => {
      assertMatch(
        formatRecord(fields({ durationMs: ms })),
        new RegExp(
          `dur=${dur.replace(".", "\\.")}s ---`,
        ),
      );
    });
  }
});
