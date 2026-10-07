/**
 * Команда `mpu log` (`docs/specs/log.md`): чтение и отбор записей
 * журнала. Голдены канала снимают поведение на синтетическом журнале
 * `journal.log`, здесь же — сверка с ними через `runLog` (вход всюду —
 * копия журнала через `--file`) и отдельные тесты на мутационные точки
 * порядка отбора и правил, которые голденами не покрыты: `--tail` после
 * фильтров, отклонения `--tail 0`/`--tail <0`, независимость `--run` от
 * прочих отборов, отбор по `--since` и чтение архивов ротации.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import {
  DomainError,
  formatCommandError,
  NotFoundIoError,
  UsageError,
} from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { parseRecords } from "./parse.ts";
import { type LogArgs, runLog } from "./cmd_log.ts";

/** Полные аргументы команды: всё, кроме названного, — умолчания схемы. */
function logArgs(overrides: Partial<LogArgs> = {}): LogArgs {
  return {
    tail: 20,
    failed: false,
    cmd: undefined,
    since: undefined,
    run: undefined,
    file: undefined,
    ...overrides,
  };
}

/** Копия эталона канала как есть — без подстановок. */
function golden(name: string): Promise<string> {
  return readFile(new URL(`./testdata/${name}`, import.meta.url), "utf8");
}

/** io, отдающий один и тот же текст на любой путь чтения. */
function ioWithFile(text: string) {
  const progressLines: string[] = [];
  const io = makeFakeIo({
    readTextFile: () => Promise.resolve(text),
    progress: (line) => progressLines.push(line),
  });
  return { io, progressLines };
}

/** Шапка синтетической записи: время всегда UTC, чтобы epoch был предсказуем. */
function header(runId: string, date: string, time: string): string {
  return `### ${date} ${time} +00:00 run=${runId} pid=1 cwd=/x`;
}

/** Синтетическая запись без секций вывода — простейшая форма журнала. */
function record(
  runId: string,
  date: string,
  time: string,
  cmd: string,
  exitCode: number,
): string {
  return (
    `${header(runId, date, time)}\n$ ${cmd}\n` +
    `--- end run=${runId} exit=${exitCode} dur=0.001s ---\n\n`
  );
}

/* --------------------------------------------------------------- *
 * Сверка с эталонами канала: вход всюду — копия journal.log через
 * --file.
 * --------------------------------------------------------------- */

it("голый вызов (--file) — эталон tail-default", async () => {
  const journal = await golden("journal.log");
  const { io } = ioWithFile(journal);
  const result = await runLog(logArgs({ file: "journal" }), io);
  expect(result.records.join("")).toStrictEqual(
    await golden("tail-default.stdout.txt"),
  );
});

it("--tail 1 — эталон tail-1", async () => {
  const journal = await golden("journal.log");
  const { io } = ioWithFile(journal);
  const result = await runLog(logArgs({ file: "journal", tail: 1 }), io);
  expect(result.records.join("")).toStrictEqual(
    await golden("tail-1.stdout.txt"),
  );
});

it("--failed — эталон failed", async () => {
  const journal = await golden("journal.log");
  const { io } = ioWithFile(journal);
  const result = await runLog(logArgs({ file: "journal", failed: true }), io);
  expect(result.records.join("")).toStrictEqual(
    await golden("failed.stdout.txt"),
  );
});

it("--cmd sql — эталон cmd-prefix (границу токена не проверяет)", async () => {
  const journal = await golden("journal.log");
  const { io } = ioWithFile(journal);
  const result = await runLog(logArgs({ file: "journal", cmd: "sql" }), io);
  expect(result.records.join("")).toStrictEqual(
    await golden("cmd-prefix.stdout.txt"),
  );
});

it("--run <ID> — эталон by-run", async () => {
  const journal = await golden("journal.log");
  const { io } = ioWithFile(journal);
  const result = await runLog(
    logArgs({ file: "journal", run: "20260801-120000.000-1003" }),
    io,
  );
  expect(result.records.join("")).toStrictEqual(
    await golden("by-run.stdout.txt"),
  );
});

it("отбор без совпадений — пустой stdout, сообщение в progress", async () => {
  const journal = await golden("journal.log");
  const { io, progressLines } = ioWithFile(journal);
  const result = await runLog(
    logArgs({ file: "journal", cmd: "такого-нет" }),
    io,
  );
  expect(result.records).toStrictEqual([]);
  expect(progressLines.length).toBe(1);
  expect(`${progressLines[0]}\n`).toStrictEqual(
    await golden("empty-result.stderr.txt"),
  );
});

it("--since вчера — UsageError, эталон err-since", async () => {
  const journal = await golden("journal.log");
  const { io } = ioWithFile(journal);
  const err = await rejected(
    () => runLog(logArgs({ file: "journal", since: "вчера" }), io),
    UsageError,
  );
  expect(`${formatCommandError("log", err)}\n`).toStrictEqual(
    await golden("err-since.stderr.txt"),
  );
});

/* --------------------------------------------------------------- *
 * Порядок отбора и правила: мутационные точки, голденами не
 * покрытые.
 * --------------------------------------------------------------- */

it("--tail применяется после отборов: --tail 1 --failed находит упавшую запись раньше хвоста", async () => {
  // Среди двух последних записей упавших нет; упавшие — самые первые.
  // Если бы --tail считался раньше --failed, отбор упавших применился бы
  // уже к хвосту из одной последней (успешной) записи и дал бы пусто.
  const journal =
    record("run-1", "2026-08-01", "10:00:00.000", "mpu a", 2) +
    record("run-2", "2026-08-01", "11:00:00.000", "mpu b", 3) +
    record("run-3", "2026-08-01", "12:00:00.000", "mpu c", 0) +
    record("run-4", "2026-08-01", "13:00:00.000", "mpu d", 0);
  const { io } = ioWithFile(journal);
  const result = await runLog(
    logArgs({ file: "journal", tail: 1, failed: true }),
    io,
  );
  expect(result.records.length).toBe(1);
  expect(result.records[0].includes("run=run-2")).toBe(true);
});

it("cmd: видит строки ask — снимается только слово ask целиком (порция 169a)", async () => {
  // Таблица «`cmd:` видит строки `ask`» спеки log.md: дверь `ask` —
  // первое слово строки, а не команда.
  const cases: ReadonlyArray<{
    readonly journal: readonly string[];
    readonly cmd: string;
    readonly picked: readonly string[];
  }> = [
    {
      journal: ["mpu telegram ls --limit 3", "mpu ask telegram status"],
      cmd: "telegram",
      picked: ["run-1", "run-2"],
    },
    {
      journal: ["mpu ask sql --target 54", "mpu sql-ro --target 54"],
      cmd: "sql",
      picked: ["run-1", "run-2"],
    },
    { journal: ["mpu ask telegram status"], cmd: "ask", picked: ["run-1"] },
    {
      journal: ["mpu ask telegram status"],
      cmd: "ask telegram",
      picked: ["run-1"],
    },
    { journal: ["mpu asksomething"], cmd: "something", picked: [] },
  ];
  for (const { journal, cmd, picked } of cases) {
    const text = journal
      .map((line, i) =>
        record(`run-${i + 1}`, "2026-08-01", `1${i}:00:00.000`, line, 0),
      )
      .join("");
    const { io } = ioWithFile(text);
    const result = await runLog(logArgs({ file: "journal", cmd }), io);
    const runs = result.records.map((r) => r.match(/run=(\S+)/)?.[1]);
    expect(runs, `cmd: ${cmd} по ${journal.join(" | ")}`).toStrictEqual([
      ...picked,
    ]);
  }
});

it("--tail 0 и --tail -5 печатают все записи (отклонение preserve)", async () => {
  const journal = await golden("journal.log");
  const all = await golden("tail-default.stdout.txt");
  for (const tail of [0, -5]) {
    const { io } = ioWithFile(journal);
    const result = await runLog(logArgs({ file: "journal", tail }), io);
    expect(result.records.join("")).toStrictEqual(all);
  }
});

it("--run не подчиняется ни --tail 1, ни --failed", async () => {
  const journal = await golden("journal.log");
  const records = parseRecords(journal);
  // Первая запись: не последняя и код выхода 0 — ни --tail 1 (оставил бы
  // только последнюю), ни --failed (оставил бы только упавшую) её одну
  // не отобрали бы.
  const target = records[0];
  expect(target.exitCode).toBe(0);
  const { io } = ioWithFile(journal);
  const result = await runLog(
    logArgs({ file: "journal", run: target.runId, tail: 1, failed: true }),
    io,
  );
  expect(result.records).toStrictEqual([target.text]);
});

it("--run с несуществующим ID — DomainError, exit-код команды 1", async () => {
  const journal = await golden("journal.log");
  const { io } = ioWithFile(journal);
  const err = await rejected(
    () => runLog(logArgs({ file: "journal", run: "нет-такого" }), io),
    DomainError,
  );
  expect(err.message).toBe("запись run=нет-такого не найдена");
});

it("--since: относительная форма и голое unix-время, граница включительная", async () => {
  const epoch = Date.UTC(2026, 7, 1, 12, 0, 0, 0) / 1000;
  const journal =
    record("on-boundary", "2026-08-01", "12:00:00.000", "mpu a", 0) +
    record("later", "2026-08-01", "12:01:40.000", "mpu b", 0);

  // Голое unix-время, ровно на границе: запись на границе входит.
  {
    const { io } = ioWithFile(journal);
    const result = await runLog(
      logArgs({ file: "journal", since: String(epoch) }),
      io,
    );
    expect(result.records.length).toBe(2);
  }

  // На секунду позже границы: запись на прежней границе больше не входит.
  {
    const { io } = ioWithFile(journal);
    const result = await runLog(
      logArgs({ file: "journal", since: String(epoch + 1) }),
      io,
    );
    expect(result.records.length).toBe(1);
  }

  // Относительная форма "2h": часы подставлены так, что since считается
  // от той же границы epoch — итог должен совпасть с голым unix-временем.
  {
    const { io } = ioWithFile(journal);
    const result = await runLog(logArgs({ file: "journal", since: "2h" }), io, {
      nowSeconds: () => epoch + 2 * 3600,
    });
    expect(result.records.length).toBe(2);
  }
});

/* --------------------------------------------------------------- *
 * Файлы журнала без --file: архивы от старых к новым, затем сам
 * журнал; отсутствующие файлы пропускаются; ошибка чтения — отказ.
 * --------------------------------------------------------------- */

it("без --file: архивы читаются старые → новые, затем журнал; недостающие пропускаются", async () => {
  const journalPath = "/home/u/.config/mpu/mpu.log";
  const files: Record<string, string> = {
    // journal.2 отсутствует намеренно — молча пропускается.
    [`${journalPath}.1`]: record(
      "old-1",
      "2026-08-01",
      "09:00:00.000",
      "mpu a",
      0,
    ),
    [journalPath]: record("new-1", "2026-08-01", "10:00:00.000", "mpu b", 0),
  };
  const io = makeFakeIo({
    envFile: {
      get: (name) =>
        name === "MPU_LOG_FILE"
          ? journalPath
          : name === "MPU_LOG_KEEP"
            ? "2"
            : undefined,
      values: () => ({}),
      require: () => {
        throw new Error("require must not be touched");
      },
      set: () => Promise.reject(new Error("set must not be touched")),
    },
    readTextFile: (path: string) => {
      if (path in files) return Promise.resolve(files[path]);
      return Promise.reject(new NotFoundIoError(`нет файла: ${path}`));
    },
    progress: () => {},
  });
  const result = await runLog(logArgs(), io);
  expect(result.records.length).toBe(2);
  expect(result.records[0].includes("run=old-1")).toBe(true);
  expect(result.records[1].includes("run=new-1")).toBe(true);
});

it("без --file: ошибка чтения (не NotFoundIoError) — DomainError с текстом причины", async () => {
  const journalPath = "/home/u/.config/mpu/mpu.log";
  const io = makeFakeIo({
    envFile: {
      get: (name) =>
        name === "MPU_LOG_FILE"
          ? journalPath
          : name === "MPU_LOG_KEEP"
            ? "0"
            : undefined,
      values: () => ({}),
      require: () => {
        throw new Error("require must not be touched");
      },
      set: () => Promise.reject(new Error("set must not be touched")),
    },
    readTextFile: () => Promise.reject(new Error("permission denied")),
    progress: () => {},
  });
  const err = await rejected(() => runLog(logArgs(), io), DomainError);
  expect(err.message).toStrictEqual(
    `не прочитать ${journalPath}: permission denied`,
  );
});
