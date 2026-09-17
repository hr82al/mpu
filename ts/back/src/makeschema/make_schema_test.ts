/**
 * Локальный стенд `mpu make-schema` (`docs/specs/make-schema.md`):
 * сборка docker-вызова, печать и подстановка client_id. Живого docker
 * в тестах нет — подпроцесс подставной.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type CacheDb,
  formatCommandError,
  type RemoteOutput,
  UsageError,
} from "../command/mod.ts";
import type { RunProcess } from "../exec/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  dockerArgs,
  makeSchemaCommand,
  runMakeSchema,
  serverNumberOf,
} from "./cmd_make_schema.ts";

const CLIENT = { id: 777, server: "sl-9", sheet: "SHEET123" };

async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/make-schema/${name}`, import.meta.url),
  );
}

/** Кэш-БД с клиентом и `sheets` таблицами у него. */
async function withCache(
  sheets: number,
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    for (
      const clientId of sheets > 1 ? [CLIENT.id, CLIENT.id + 1] : [CLIENT.id]
    ) {
      db.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, ?)",
        clientId,
        CLIENT.server,
        1_700_000_000,
      );
      db.execute(
        "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
          " server, synced_at) VALUES (?, ?, ?, 1, ?, ?)",
        `${CLIENT.sheet}-${clientId - CLIENT.id}`,
        clientId,
        `Таблица ${clientId - CLIENT.id}`,
        CLIENT.server,
        1_700_000_000,
      );
    }
    await body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function io(db: CacheDb) {
  const parts: string[] = [];
  const output: RemoteOutput = {
    out: (chunk) => void parts.push(new TextDecoder().decode(chunk)),
    err: (chunk) => void parts.push(new TextDecoder().decode(chunk)),
    captured: () => parts.join(""),
  };
  return makeFakeIo({
    envFile: {
      get: () => undefined,
      require: () => {
        throw new Error("env-файл этой команде не нужен");
      },
      set: () => Promise.reject(new Error("запись не ожидается")),
      values: () => ({}),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
    openRemoteOutput: () => output,
  });
}

/** Подставной подпроцесс: помнит вызов и отдаёт код. */
function fakeDocker(code = 0) {
  const calls: { bin: string; args: readonly string[] }[] = [];
  const run: RunProcess = (bin, args, _stdin, output) => {
    calls.push({ bin, args: [...args] });
    output.out(new TextEncoder().encode("схема создана\n"));
    return Promise.resolve(code);
  };
  return { run, calls };
}

const args = (overrides: Record<string, unknown> = {}) => ({
  selector: String(CLIENT.id),
  server: undefined,
  "client-id": undefined,
  print: true,
  ...overrides,
});

Deno.test("печать: docker-команда одной строкой — эталон канала", async () => {
  await withCache(1, async (db) => {
    const copied: string[] = [];
    const result = await runMakeSchema(args(), io(db), {
      copy: (text) => {
        copied.push(text);
        return Promise.resolve(true);
      },
    });
    assertEquals(
      makeSchemaCommand.renderResult(result, ["777", "-p"]),
      await golden("make-schema-print.stdout.txt"),
    );
    // В буфер уходит ровно напечатанная строка.
    assertEquals(copied, [result.printed]);
    assertEquals(result.exitCode, 0);
  });
});

Deno.test("выполнение: локальный docker, а не ssh и не Portainer", async () => {
  await withCache(1, async (db) => {
    const docker = fakeDocker();
    const result = await runMakeSchema(
      args({ print: false }),
      io(db),
      { runProcess: docker.run },
    );
    assertEquals(docker.calls.length, 1);
    // Именно локальный подпроцесс `docker`: ни ssh, ни Portainer в
    // вызове нет по построению (спека, «Побочные эффекты»).
    assertEquals(docker.calls[0].bin, "docker");
    assertEquals(docker.calls[0].args[0], "exec");
    assertEquals(docker.calls[0].args[1], "mp-sl-1-cli");
    assertEquals(result.printed, null);
    assertStringIncludes(result.output, "схема создана");
  });
});

Deno.test("код выхода docker наследуется 1:1", async () => {
  await withCache(1, async (db) => {
    const docker = fakeDocker(3);
    const result = await runMakeSchema(args({ print: false }), io(db), {
      runProcess: docker.run,
    });
    assertEquals(result.exitCode, 3);
    assertEquals(makeSchemaCommand.textExitCode?.(result), 3);
  });
});

Deno.test("--server меняет номер и в контейнере, и внутри вызова", () => {
  assertEquals(dockerArgs(2, 777), [
    "exec",
    "mp-sl-2-cli",
    "node",
    "cli",
    "service:clientsMigrations",
    "init",
    "--client-id",
    "777",
    "--server",
    "sl-2",
  ]);
  assertEquals(serverNumberOf(undefined), 1);
  assertEquals(serverNumberOf("sl-2"), 2);
});

Deno.test("--server не вида sl-N — ошибка ввода", () => {
  const cases = ["2", "sl2", "sl-", "dev:1"];
  for (const value of cases) {
    let failed = false;
    try {
      serverNumberOf(value);
    } catch (err) {
      failed = err instanceof UsageError;
    }
    assertEquals(failed, true, `${value} прошёл`);
  }
});

Deno.test("явный --client-id кэш не открывает", async () => {
  const io = makeFakeIo({
    openCacheDb: () => {
      throw new Error("кэш не должен открываться");
    },
    openRemoteOutput: () => {
      throw new Error("вывод не нужен на печати");
    },
  });
  const result = await runMakeSchema(
    { selector: "что угодно", server: "sl-3", "client-id": 42, print: true },
    io,
    { copy: () => Promise.resolve(true) },
  );
  assertStringIncludes(result.command, "mp-sl-3-cli");
  assertStringIncludes(result.command, "--client-id 42 --server sl-3");
});

Deno.test("неоднозначный клиент — отказ со списком кандидатов", async () => {
  await withCache(2, async (db) => {
    const err = await assertRejects(
      () => runMakeSchema(args({ selector: "Таблица" }), io(db)),
      UsageError,
    );
    assertEquals(
      `${formatCommandError("make-schema", err)}\n`,
      await golden("err-ambiguous-client-stderr.txt"),
    );
  });
});
