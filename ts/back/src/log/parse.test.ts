/**
 * Разбор журнала (`docs/specs/log.md`, «Ввод/вывод»): граница записи по
 * паре маркеров, а держит её совпадение `run=<ID>`, а не вид строки —
 * похожий на маркер текст внутри вывода команды разрывать запись не
 * должен. Тексты записей строятся вручную по формату
 * `platform/invoke-log.md`, а не через `formatRecord`: разбор обязан
 * работать по самим байтам файла, и тест не должен зависеть от того же
 * слоя сборки, что и код под тестом.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseRecords } from "./parse.ts";
import { selectRecords } from "./select.ts";

/** Шапка записи в формате журнала: время, зона (по умолчанию UTC), run. */
function header(
  runId: string,
  opts: {
    readonly date?: string;
    readonly time?: string;
    readonly offset?: string;
  } = {},
): string {
  const date = opts.date ?? "2026-08-01";
  const time = opts.time ?? "10:00:00.000";
  const offset = opts.offset ?? "+00:00";
  return `### ${date} ${time} ${offset} run=${runId} pid=1 cwd=/x`;
}

it("journal.log: три записи с верными runId/commandLine/exitCode", async () => {
  const text = await readFile(
    new URL("testdata/journal.log", import.meta.url),
    "utf8",
  );
  const records = parseRecords(text);
  expect(records.length).toBe(3);
  expect(records[0].runId).toBe("20260801-100000.100-1001");
  expect(records[0].commandLine).toBe("mpu sql-ro 10 'select 1'");
  expect(records[0].exitCode).toBe(0);
  expect(records[1].runId).toBe("20260801-113005.900-1002");
  expect(records[1].commandLine).toBe("mpu sql 10 --password REDACTED");
  expect(records[1].exitCode).toBe(2);
  expect(records[2].runId).toBe("20260801-120000.000-1003");
  expect(records[2].commandLine).toBe("mpu ps sl-9");
  expect(records[2].exitCode).toBe(0);
});

it("текст, похожий на закрывающий маркер чужой записи, границу не рвёт", () => {
  // Внутри `out` встречается строка вида "--- end run=<чужой-id> exit=0 …":
  // граница держится совпадением run=<ID>, поэтому запись должна
  // закрыться только своим собственным маркером.
  const text = [
    header("real-1"),
    "$ mpu something",
    "--- out run=real-1 ---",
    "before",
    "--- end run=чужой-id exit=0 dur=1s ---",
    "after",
    "--- end run=real-1 exit=0 dur=0.500s ---",
    "",
    "",
  ].join("\n");
  const records = parseRecords(text);
  expect(records.length).toBe(1);
  expect(records[0].runId).toBe("real-1");
  expect(records[0].exitCode).toBe(0);
  expect(records[0].text.includes("--- end run=чужой-id exit=0 dur=1s ---"))
    .toBe(true);
});

it("оборванная запись (нет закрывающего маркера): печатается тем, что накопилось, следующая не съедена", () => {
  const text = [
    header("broken-1"),
    "$ mpu one",
    "--- out run=broken-1 ---",
    "часть вывода без конца",
    header("next-1"),
    "$ mpu two",
    "--- end run=next-1 exit=0 dur=0.100s ---",
    "",
    "",
  ].join("\n");
  const records = parseRecords(text);
  expect(records.length).toBe(2);
  expect(records[0].runId).toBe("broken-1");
  expect(records[0].exitCode).toStrictEqual(null);
  expect(records[0].text.includes("часть вывода без конца")).toBe(true);
  expect(records[0].text.includes("next-1")).toBe(false);
  expect(records[1].runId).toBe("next-1");
  expect(records[1].exitCode).toBe(0);
  expect(records[1].text.includes("mpu two")).toBe(true);
});

it("мусор до первой шапки пропускается", () => {
  const text = [
    "какой-то обрывок предыдущей ротации",
    "ещё мусор, не похожий на шапку",
    header("clean-1"),
    "$ mpu clean",
    "--- end run=clean-1 exit=0 dur=0.010s ---",
    "",
    "",
  ].join("\n");
  const records = parseRecords(text);
  expect(records.length).toBe(1);
  expect(records[0].runId).toBe("clean-1");
  expect(records[0].text.includes("мусор")).toBe(false);
});

it("нечитаемое время шапки: видна без --since, отсеивается любым --since", () => {
  // Месяц 13 — не разбираемая дата: `Date.parse` возвращает NaN, и
  // `startedAtOf` отдаёт null (спека, «Граничные случаи»).
  const text = [
    header("badtime-1", { date: "2026-13-01" }),
    "$ mpu odd",
    "--- end run=badtime-1 exit=0 dur=0.010s ---",
    "",
    "",
  ].join("\n");
  const records = parseRecords(text);
  expect(records.length).toBe(1);
  expect(records[0].startedAt).toStrictEqual(null);

  const withoutSince = selectRecords(records, { failed: false, tail: 0 });
  expect(withoutSince.length).toBe(1);

  const withSince = selectRecords(records, {
    failed: false,
    tail: 0,
    since: 0,
  });
  expect(withSince.length).toBe(0);
});

it("закрывающий маркер без exit= кодом не считается успехом", () => {
  // Испорченный маркер запись закрывает, но кода не даёт: подставленный
  // ноль спрятал бы её от `--failed` (`specs/log.md`, «Инварианты»).
  const text = [
    "### 2026-08-01 10:00:00.100 +03:00 run=r-1 pid=1 cwd=/tmp",
    "$ mpu ps sl-9",
    "--- end run=r-1 dur=0.100s ---",
    "",
  ].join("\n");
  const records = parseRecords(text);
  expect(records.length).toBe(1);
  expect(records[0].exitCode).toStrictEqual(null);
});
