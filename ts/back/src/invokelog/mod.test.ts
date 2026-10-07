import { assert, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type InvokeLog,
  type InvokeLogDeps,
  makeInvokeLog,
  NO_INVOKE_LOG,
} from "./mod.ts";

// Путь — заглушка: тесты этого файла маскирование не проверяют, поэтому
// им годится любое значение, лишь бы совпадало по смыслу с `argv`.
const LOGGED = {
  logsOutput: true,
  logsArguments: true,
  logsStdout: true,
  path: [],
} as const;

/** Журнал поверх временного каталога; тело получает журнал и путь файла. */
async function withLog(
  body: (log: InvokeLog, path: string, dir: string) => Promise<void>,
  patch: Partial<InvokeLogDeps> = {},
  keys: (dir: string) => Readonly<Record<string, string>> = () => ({}),
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const path = `${dir}/mpu.log`;
  const values = keys(dir);
  try {
    await body(
      makeInvokeLog({
        env: { get: (name) => values[name] },
        defaultFile: path,
        pid: 4242,
        now: () => new Date("2026-08-05T04:42:28.205Z"),
        ...patch,
      }),
      path,
      dir,
    );
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Содержимое журнала; файла нет — пустая строка. */
async function logText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

describe("запись появляется только у помеченного вызова", () => {
  it("без пометки native — файла нет вовсе", async () => {
    await withLog(async (log, path) => {
      const record = log.begin({
        kind: "argv",
        argv: ["version"],
        cwd: "/work",
      });
      record.capture({ stdout: () => {}, stderr: () => {} }).stdout("1.2.3\n");
      await record.finish(0);
      expect(await logText(path)).toBe("");
    });
  });
  it("с пометкой — ровно одна запись", async () => {
    await withLog(async (log, path) => {
      const record = log.begin({
        kind: "argv",
        argv: ["xlsx", "ls"],
        cwd: "/work",
      });
      record.nativeCall(LOGGED);
      await record.finish(0);
      const text = await logText(path);
      expect(text.match(/^### /gmu)?.length).toBe(1);
      expect(text).toMatch(
        /^### \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d run=\d{8}-\d{6}\.\d{3}-4242 pid=4242 cwd=\/work$/mu,
      );
      expect(text).toMatch(/^\$ mpu xlsx ls$/mu);
      expect(text).toMatch(
        /^--- end run=\d{8}-\d{6}\.\d{3}-4242 exit=0 dur=0\.\d{3}s ---$/mu,
      );
    });
  });
});

it("строку исполнил другой процесс: его pid в шапке, run= и имени", async () => {
  // `platform/line-executor.md`: запись ведёт ядро, а исполняет
  // исполнитель — шапка называет того, кто исполнил.
  await withLog(async (log, path) => {
    const record = log.begin({ kind: "argv", argv: ["jsdate"], cwd: "/work" });
    record.nativeCall(LOGGED);
    record.executedBy(9001);
    expect(record.runId().endsWith("-9001"), record.runId()).toBe(true);
    await record.finish(0);
    const text = await logText(path);
    expect(text).toMatch(
      /^### \S+ \S+ [+-]\d\d:\d\d run=\d{8}-\d{6}\.\d{3}-9001 pid=9001 cwd=\/work$/mu,
    );
    expect(text).toMatch(/^--- end run=\d{8}-\d{6}\.\d{3}-9001 exit=0 /mu);
  });
});

it("копия копится только у помеченного вызова", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      kind: "argv",
      argv: ["xlsx", "ls"],
      cwd: "/work",
    });
    const output = record.capture({ stdout: () => {}, stderr: () => {} });
    // До пометки вызов ещё может оказаться нежурналируемым — и тогда
    // копить копию нечего: у `mpu mcp` процесс живёт часами.
    output.stdout("до пометки\n");
    record.out("тоже до\n");
    record.nativeCall(LOGGED);
    output.stdout("после пометки\n");
    await record.finish(0);
    const text = await logText(path);
    expect(text).toMatch(/^--- out run=\S+ ---\nпосле пометки\n/mu);
    expect(text.includes("до пометки")).toBe(false);
    expect(text.includes("тоже до")).toBe(false);
  });
});

it("перехват вывода: копия в запись, печать не меняется", async () => {
  await withLog(async (log, path) => {
    const printed: string[] = [];
    const record = log.begin({
      kind: "argv",
      argv: ["xlsx", "ls"],
      cwd: "/work",
    });
    record.nativeCall(LOGGED);
    const output = record.capture({
      stdout: (text) => printed.push(`out:${text}`),
      stderr: (text) => printed.push(`err:${text}`),
    });
    output.stdout("данные\n");
    output.stderr("диагностика\n");
    await record.finish(0);
    expect(printed).toStrictEqual(["out:данные\n", "err:диагностика\n"]);
    const text = await logText(path);
    expect(text).toMatch(/^--- out run=\S+ ---\nданные\n/mu);
    expect(text).toMatch(/^--- err run=\S+ ---\nдиагностика\n/mu);
  });
});

/** Пометка `telegram log`: аргументы в запись не попадают (`specs/telegram-log.md`). */
const MASKED_ARGS = {
  logsOutput: true,
  logsArguments: false,
  logsStdout: true,
  path: ["telegram", "log"],
} as const;

it("помеченная команда: ошибка ввода уходит в запись маской", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      cwd: "/work",
      kind: "argv",
      argv: ["telegram", "log", "заметка", "-f", "/home/me/тайна.md"],
    });
    record.nativeCall(MASKED_ARGS);
    const output = record.capture({ stdout: () => {}, stderr: () => {} });
    output.stderr(
      "mpu telegram log: файл-вложение не найден: /home/me/тайна.md\n",
    );
    await record.finish(2);
    const text = await logText(path);
    // Строка вызова замаскирована по пути команды, и текст отказа не
    // вправе вернуть тот же ввод обратно через секцию err.
    expect(text.includes("/home/me/тайна.md")).toBe(false);
    expect(text).toMatch(/^--- err run=\S+ ---\nREDACTED\n/mu);
  });
});

it("помеченная команда: отказ внешней системы остаётся в записи", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      cwd: "/work",
      kind: "argv",
      argv: ["telegram", "log", "заметка"],
    });
    record.nativeCall(MASKED_ARGS);
    const output = record.capture({ stdout: () => {}, stderr: () => {} });
    output.stderr("telegram: bot API 400 Bad Request: chat not found\n");
    await record.finish(1);
    expect(await logText(path)).toMatch(
      /^--- err run=\S+ ---\ntelegram: bot API 400 Bad Request: chat not found\n/mu,
    );
  });
});

it("команда без записи вывода: запись есть, секций нет", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      kind: "argv",
      argv: ["mcp", "token"],
      cwd: "/work",
    });
    record.nativeCall({
      logsOutput: false,
      logsArguments: true,
      logsStdout: true,
      path: [
        "mcp",
        "token",
      ],
    });
    const output = record.capture({ stdout: () => {}, stderr: () => {} });
    output.stdout('{"Authorization":"Bearer s3cret"}\n');
    output.stderr("шум\n");
    await record.finish(0);
    const text = await logText(path);
    expect(text).toMatch(/^\$ mpu mcp token$/mu);
    expect(text.includes("s3cret")).toBe(false);
    expect(text.includes("--- out ")).toBe(false);
    expect(text.includes("--- err ")).toBe(false);
  });
});

it("команда без записи stdout: out нет, err и note есть", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      kind: "argv",
      argv: ["ozon", "call-ro", "target:", "54", "path:", "/v1/seller/info"],
      cwd: "/work",
    });
    record.nativeCall({
      logsOutput: true,
      logsArguments: true,
      logsStdout: false,
      path: ["ozon", "call-ro"],
    });
    const output = record.capture({ stdout: () => {}, stderr: () => {} });
    output.stdout('{"name":"cool_flaps"}\n');
    output.stderr("отказ\n");
    record.note("HTTP 200, тело 21 байт");
    await record.finish(0);
    const text = await logText(path);
    expect(text).toMatch(
      /^\$ mpu ozon call-ro target: 54 path: \/v1\/seller\/info$/mu,
    );
    expect(text.includes("cool_flaps")).toBe(false);
    expect(text.includes("--- out ")).toBe(false);
    expect(text).toMatch(/^--- err run=\S+ ---\nотказ\n/mu);
    expect(text).toMatch(/^--- note run=\S+ ---\nHTTP 200, тело 21 байт\n/mu);
    expect(text).toMatch(/^--- end run=\S+ exit=0 /mu);
  });
});

it("выключенный журнал не пишет ничего", async () => {
  await withLog(
    async (log, path) => {
      const record = log.begin({
        kind: "argv",
        argv: ["xlsx", "ls"],
        cwd: "/work",
      });
      record.nativeCall(LOGGED);
      await record.finish(0);
      expect(await logText(path)).toBe("");
    },
    {},
    () => ({ MPU_LOG_ENABLED: "off" }),
  );
});

it("путь файла берётся из ключа env-файла", async () => {
  await withLog(
    async (log, path, dir) => {
      const custom = `${dir}/своё.log`;
      const record = log.begin({
        kind: "argv",
        argv: ["xlsx", "ls"],
        cwd: "/work",
      });
      record.nativeCall(LOGGED);
      await record.finish(0);
      expect(await logText(path)).toBe("");
      expect(await logText(custom)).toMatch(/^\$ mpu xlsx ls$/mu);
    },
    {},
    (dir) => ({ MPU_LOG_FILE: `${dir}/своё.log` }),
  );
});

it("битое числовое значение — note в этой же записи", async () => {
  await withLog(
    async (log, path) => {
      const record = log.begin({
        kind: "argv",
        argv: ["xlsx", "ls"],
        cwd: "/work",
      });
      record.nativeCall(LOGGED);
      await record.finish(0);
      expect(await logText(path)).toMatch(
        /^--- note run=\S+ ---\nMPU_LOG_MAX_BYTES=много: не целое неотрицательное число, взято умолчание 50000000$/mu,
      );
    },
    {},
    () => ({ MPU_LOG_MAX_BYTES: "много" }),
  );
});

it("секреты argv в запись не попадают", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      cwd: "/work",
      kind: "argv",
      argv: ["sql-ro", "sl-1", "--token", "s3cret"],
    });
    record.nativeCall(LOGGED);
    await record.finish(2);
    const text = await logText(path);
    expect(text).toMatch(/^\$ mpu sql-ro sl-1 --token REDACTED$/mu);
    expect(text.includes("s3cret")).toBe(false);
  });
});

it("помеченная команда: аргументы под маской, путь цел", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      cwd: "/work",
      kind: "argv",
      argv: ["telegram", "log", "личная заметка"],
    });
    record.nativeCall({
      logsOutput: true,
      logsArguments: false,
      logsStdout: true,
      path: ["telegram", "log"],
    });
    await record.finish(0);
    const text = await logText(path);
    expect(text).toMatch(/^\$ mpu telegram log REDACTED$/mu);
    expect(text.includes("личная заметка")).toBe(false);
  });
});

it("помеченная команда: общий --json между сегментами пути не режет путь", async () => {
  await withLog(async (log, path) => {
    // Путь в argv не обязан быть непрерывным префиксом — общий
    // `--json` вставляется между его сегментами
    // (`entrypoint/mod_test.ts`, `xlsx --json alias ls`). Помеченная
    // команда обязана и в этом случае оставить путь целым, замаскировав
    // сам `--json` наравне с текстом заметки.
    const record = log.begin({
      cwd: "/work",
      kind: "argv",
      argv: ["telegram", "--json", "log", "личная заметка"],
    });
    record.nativeCall({
      logsOutput: true,
      logsArguments: false,
      logsStdout: true,
      path: ["telegram", "log"],
    });
    await record.finish(0);
    const text = await logText(path);
    expect(text).toMatch(/^\$ mpu telegram REDACTED log REDACTED$/mu);
    expect(text.includes("личная заметка")).toBe(false);
  });
});

it("вызов тула: путь через пробел и JSON одной строкой", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      cwd: "/work",
      kind: "tool",
      path: ["xlsx", "ls"],
      input: { path: "/tmp/a.xlsx", token: "s3cret" },
    });
    record.nativeCall(LOGGED);
    record.out('{"sheets":[]}');
    await record.finish(0);
    const text = await logText(path);
    expect(text).toMatch(
      /^\$ mpu xlsx ls '\{"path":"\/tmp\/a\.xlsx","token":"REDACTED"\}'$/mu,
    );
    expect(text.includes("s3cret")).toBe(false);
  });
});

it("run_id различаются у вызовов в одну миллисекунду", async () => {
  await withLog(async (log, path) => {
    for (const argv of [["a"], ["b"], ["c"]]) {
      const record = log.begin({ kind: "argv", argv, cwd: "/work" });
      record.nativeCall(LOGGED);
      await record.finish(0);
    }
    const ids = [
      ...(await logText(path)).matchAll(/^### \S+ \S+ \S+ run=(\S+) /gmu),
    ]
      .map((match) => match[1]);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size, `run_id повторились: ${ids.join(", ")}`).toBe(3);
  });
});

describe("fail-open: журнал не бросает и не меняет исход", () => {
  it("писать некуда — путь занят файлом", async () => {
    await withLog(
      async (log, _path, dir) => {
        const blocked = `${dir}/занято`;
        await writeFile(blocked, "");
        const record = log.begin({
          kind: "argv",
          argv: ["xlsx", "ls"],
          cwd: "/work",
        });
        record.nativeCall(LOGGED);
        await record.finish(0);
        expect(await readFile(blocked, "utf8")).toBe("");
      },
      {},
      (dir) => ({ MPU_LOG_FILE: `${dir}/занято/mpu.log` }),
    );
  });
  it("путь файла неизвестен вовсе", async () => {
    await withLog(async (log) => {
      const record = log.begin({
        kind: "argv",
        argv: ["xlsx", "ls"],
        cwd: "/work",
      });
      record.nativeCall(LOGGED);
      await record.finish(0);
    }, { defaultFile: undefined });
  });
});

it("журнал-пустышка не пишет и не мешает печати", async () => {
  const printed: string[] = [];
  const record = NO_INVOKE_LOG.begin({
    kind: "argv",
    argv: ["version"],
    cwd: "/work",
  });
  record.nativeCall(LOGGED);
  const output = record.capture({
    stdout: (text) => printed.push(text),
    stderr: () => {},
  });
  output.stdout("1.2.3\n");
  record.out("x");
  record.err("y");
  await record.finish(0);
  expect(printed).toStrictEqual(["1.2.3\n"]);
  assert(true);
});
