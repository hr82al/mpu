import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  type InvokeLog,
  type InvokeLogDeps,
  makeInvokeLog,
  NO_INVOKE_LOG,
} from "./mod.ts";

// Путь — заглушка: тесты этого файла маскирование не проверяют, поэтому
// им годится любое значение, лишь бы совпадало по смыслу с `argv`.
const LOGGED = { logsOutput: true, logsArguments: true, path: [] } as const;

/** Журнал поверх временного каталога; тело получает журнал и путь файла. */
async function withLog(
  body: (log: InvokeLog, path: string, dir: string) => Promise<void>,
  patch: Partial<InvokeLogDeps> = {},
  keys: (dir: string) => Readonly<Record<string, string>> = () => ({}),
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/mpu.log`;
  const values = keys(dir);
  try {
    await body(
      makeInvokeLog({
        env: { get: (name) => values[name] },
        defaultFile: path,
        pid: 4242,
        cwd: () => "/work",
        now: () => new Date("2026-08-05T04:42:28.205Z"),
        ...patch,
      }),
      path,
      dir,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Содержимое журнала; файла нет — пустая строка. */
async function logText(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw err;
  }
}

Deno.test("запись появляется только у помеченного вызова", async (t) => {
  await t.step("без пометки native — файла нет вовсе", async () => {
    await withLog(async (log, path) => {
      const record = log.begin({ kind: "argv", argv: ["version"] });
      record.capture({ stdout: () => {}, stderr: () => {} }).stdout("1.2.3\n");
      await record.finish(0);
      assertEquals(await logText(path), "");
    });
  });
  await t.step("с пометкой — ровно одна запись", async () => {
    await withLog(async (log, path) => {
      const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
      record.nativeCall(LOGGED);
      await record.finish(0);
      const text = await logText(path);
      assertEquals(text.match(/^### /gmu)?.length, 1);
      assertMatch(
        text,
        /^### \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d run=\d{8}-\d{6}\.\d{3}-4242 pid=4242 cwd=\/work$/mu,
      );
      assertMatch(text, /^\$ mpu xlsx ls$/mu);
      assertMatch(
        text,
        /^--- end run=\d{8}-\d{6}\.\d{3}-4242 exit=0 dur=0\.\d{3}s ---$/mu,
      );
    });
  });
});

Deno.test("копия копится только у помеченного вызова", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
    const output = record.capture({ stdout: () => {}, stderr: () => {} });
    // До пометки вызов ещё может оказаться нежурналируемым — и тогда
    // копить копию нечего: у `mpu mcp` процесс живёт часами.
    output.stdout("до пометки\n");
    record.out("тоже до\n");
    record.nativeCall(LOGGED);
    output.stdout("после пометки\n");
    await record.finish(0);
    const text = await logText(path);
    assertMatch(text, /^--- out run=\S+ ---\nпосле пометки\n/mu);
    assertEquals(text.includes("до пометки"), false);
    assertEquals(text.includes("тоже до"), false);
  });
});

Deno.test("перехват вывода: копия в запись, печать не меняется", async () => {
  await withLog(async (log, path) => {
    const printed: string[] = [];
    const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
    record.nativeCall(LOGGED);
    const output = record.capture({
      stdout: (text) => printed.push(`out:${text}`),
      stderr: (text) => printed.push(`err:${text}`),
    });
    output.stdout("данные\n");
    output.stderr("диагностика\n");
    await record.finish(0);
    assertEquals(printed, ["out:данные\n", "err:диагностика\n"]);
    const text = await logText(path);
    assertMatch(text, /^--- out run=\S+ ---\nданные\n/mu);
    assertMatch(text, /^--- err run=\S+ ---\nдиагностика\n/mu);
  });
});

Deno.test("команда без записи вывода: запись есть, секций нет", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({ kind: "argv", argv: ["mcp", "token"] });
    record.nativeCall({
      logsOutput: false,
      logsArguments: true,
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
    assertMatch(text, /^\$ mpu mcp token$/mu);
    assertEquals(text.includes("s3cret"), false);
    assertEquals(text.includes("--- out "), false);
    assertEquals(text.includes("--- err "), false);
  });
});

Deno.test("выключенный журнал не пишет ничего", async () => {
  await withLog(
    async (log, path) => {
      const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
      record.nativeCall(LOGGED);
      await record.finish(0);
      assertEquals(await logText(path), "");
    },
    {},
    () => ({ MPU_LOG_ENABLED: "off" }),
  );
});

Deno.test("путь файла берётся из ключа env-файла", async () => {
  await withLog(
    async (log, path, dir) => {
      const custom = `${dir}/своё.log`;
      const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
      record.nativeCall(LOGGED);
      await record.finish(0);
      assertEquals(await logText(path), "");
      assertMatch(await logText(custom), /^\$ mpu xlsx ls$/mu);
    },
    {},
    (dir) => ({ MPU_LOG_FILE: `${dir}/своё.log` }),
  );
});

Deno.test("битое числовое значение — note в этой же записи", async () => {
  await withLog(
    async (log, path) => {
      const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
      record.nativeCall(LOGGED);
      await record.finish(0);
      assertMatch(
        await logText(path),
        /^--- note run=\S+ ---\nMPU_LOG_MAX_BYTES=много: не целое неотрицательное число, взято умолчание 50000000$/mu,
      );
    },
    {},
    () => ({ MPU_LOG_MAX_BYTES: "много" }),
  );
});

Deno.test("секреты argv в запись не попадают", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      kind: "argv",
      argv: ["sql-ro", "sl-1", "--token", "s3cret"],
    });
    record.nativeCall(LOGGED);
    await record.finish(2);
    const text = await logText(path);
    assertMatch(text, /^\$ mpu sql-ro sl-1 --token REDACTED$/mu);
    assertEquals(text.includes("s3cret"), false);
  });
});

Deno.test("вызов тула: путь через пробел и JSON одной строкой", async () => {
  await withLog(async (log, path) => {
    const record = log.begin({
      kind: "tool",
      path: ["xlsx", "ls"],
      input: { path: "/tmp/a.xlsx", token: "s3cret" },
    });
    record.nativeCall(LOGGED);
    record.out('{"sheets":[]}');
    await record.finish(0);
    const text = await logText(path);
    assertMatch(
      text,
      /^\$ mpu xlsx ls '\{"path":"\/tmp\/a\.xlsx","token":"REDACTED"\}'$/mu,
    );
    assertEquals(text.includes("s3cret"), false);
  });
});

Deno.test("run_id различаются у вызовов в одну миллисекунду", async () => {
  await withLog(async (log, path) => {
    for (const argv of [["a"], ["b"], ["c"]]) {
      const record = log.begin({ kind: "argv", argv });
      record.nativeCall(LOGGED);
      await record.finish(0);
    }
    const ids = [
      ...(await logText(path)).matchAll(/^### \S+ \S+ \S+ run=(\S+) /gmu),
    ]
      .map((match) => match[1]);
    assertEquals(ids.length, 3);
    assertEquals(new Set(ids).size, 3, `run_id повторились: ${ids.join(", ")}`);
  });
});

Deno.test("fail-open: журнал не бросает и не меняет исход", async (t) => {
  await t.step("писать некуда — путь занят файлом", async () => {
    await withLog(
      async (log, _path, dir) => {
        const blocked = `${dir}/занято`;
        await Deno.writeTextFile(blocked, "");
        const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
        record.nativeCall(LOGGED);
        await record.finish(0);
        assertEquals(await Deno.readTextFile(blocked), "");
      },
      {},
      (dir) => ({ MPU_LOG_FILE: `${dir}/занято/mpu.log` }),
    );
  });
  await t.step("путь файла неизвестен вовсе", async () => {
    await withLog(async (log) => {
      const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
      record.nativeCall(LOGGED);
      await record.finish(0);
    }, { defaultFile: undefined });
  });
  await t.step("cwd недоступен", async () => {
    await withLog(async (log, path) => {
      const record = log.begin({ kind: "argv", argv: ["xlsx", "ls"] });
      record.nativeCall(LOGGED);
      await record.finish(0);
      assertEquals(await logText(path), "");
    }, {
      cwd: () => {
        throw new Deno.errors.NotFound("каталог исчез");
      },
    });
  });
});

Deno.test("журнал-пустышка не пишет и не мешает печати", async () => {
  const printed: string[] = [];
  const record = NO_INVOKE_LOG.begin({ kind: "argv", argv: ["version"] });
  record.nativeCall(LOGGED);
  const output = record.capture({
    stdout: (text) => printed.push(text),
    stderr: () => {},
  });
  output.stdout("1.2.3\n");
  record.out("x");
  record.err("y");
  await record.finish(0);
  assertEquals(printed, ["1.2.3\n"]);
  assert(true);
});
