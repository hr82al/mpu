/**
 * Локальный стенд `mpu make-schema` (`docs/specs/make-schema.md`):
 * сборка docker-вызова, печать и подстановка client_id. Живого docker
 * в тестах нет — подпроцесс подставной.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
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
  return await readFile(
    new URL(`./testdata/make-schema/${name}`, import.meta.url),
    "utf8",
  );
}

/** Кэш-БД с клиентом и `sheets` таблицами у него. */
async function withCache(
  sheets: number,
  body: (db: CacheDb) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
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
    await rm(dir, { recursive: true });
  }
}

function io(db: CacheDb) {
  const parts: string[] = [];
  const output: RemoteOutput = {
    out: (chunk) => {
      parts.push(new TextDecoder().decode(chunk));
      return Promise.resolve();
    },
    err: (chunk) => {
      parts.push(new TextDecoder().decode(chunk));
      return Promise.resolve();
    },
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
  const calls: { bin: string; args: readonly string[]; cwd: string }[] = [];
  const run: RunProcess = (bin, args, proc) => {
    calls.push({ bin, args: [...args], cwd: proc.cwd });
    proc.output.out(new TextEncoder().encode("схема создана\n"));
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

it("печать: docker-команда одной строкой — эталон канала", async () => {
  await withCache(1, async (db) => {
    const copied: string[] = [];
    const result = await runMakeSchema(args(), io(db), {
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    expect(makeSchemaCommand.renderResult(result, ["777", "-p"])).toStrictEqual(
      await golden("make-schema-print.stdout.txt"),
    );
    // В буфер уходит ровно напечатанная строка.
    expect(copied).toStrictEqual([result.printed]);
    expect(result.exitCode).toBe(0);
  });
});

it("выполнение: локальный docker, а не ssh и не Portainer", async () => {
  await withCache(1, async (db) => {
    const docker = fakeDocker();
    const result = await runMakeSchema(
      args({ print: false }),
      io(db),
      { runProcess: docker.run },
    );
    expect(docker.calls.length).toBe(1);
    // Именно локальный подпроцесс `docker`: ни ssh, ни Portainer в
    // вызове нет по построению (спека, «Побочные эффекты»).
    expect(docker.calls[0].bin).toBe("docker");
    expect(docker.calls[0].args[0]).toBe("exec");
    expect(docker.calls[0].args[1]).toBe("mp-sl-1-cli");
    // Каталог старта — каталог вызывающего, а не процесса
    // (`platform/line-concurrency.md`).
    expect(docker.calls[0].cwd).toStrictEqual(io(db).cwd());
    expect(result.printed).toStrictEqual(null);
    expect(result.output).toContain("схема создана");
  });
});

it("код выхода docker наследуется 1:1", async () => {
  await withCache(1, async (db) => {
    const docker = fakeDocker(3);
    const result = await runMakeSchema(args({ print: false }), io(db), {
      runProcess: docker.run,
    });
    expect(result.exitCode).toBe(3);
    expect(makeSchemaCommand.textExitCode?.(result)).toBe(3);
  });
});

it("--server меняет номер и в контейнере, и внутри вызова", () => {
  expect(dockerArgs(2, 777)).toStrictEqual([
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
  expect(serverNumberOf(undefined)).toBe(1);
  expect(serverNumberOf("sl-2")).toBe(2);
});

it("--server не вида sl-N — ошибка ввода", () => {
  const cases = ["2", "sl2", "sl-", "dev:1"];
  for (const value of cases) {
    let failed = false;
    try {
      serverNumberOf(value);
    } catch (err) {
      failed = err instanceof UsageError;
    }
    expect(failed, `${value} прошёл`).toBe(true);
  }
});

it("явный --client-id кэш не открывает", async () => {
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
    { copy: () => Promise.resolve() },
  );
  expect(result.command).toContain("mp-sl-3-cli");
  expect(result.command).toContain("--client-id 42 --server sl-3");
});

it("неоднозначный клиент — отказ со списком кандидатов", async () => {
  await withCache(2, async (db) => {
    const err = await rejected(
      () => runMakeSchema(args({ selector: "Таблица" }), io(db)),
      UsageError,
    );
    expect(`${formatCommandError("make-schema", err)}\n`).toStrictEqual(
      await golden("err-ambiguous-client-stderr.txt"),
    );
  });
});
