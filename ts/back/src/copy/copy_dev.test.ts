/**
 * Команда `mpu copy-dev` (`docs/specs/copy-dev.md`): два режима, общая
 * с `copy-client` машинерия и направление записи.
 *
 * Живого dev-стенда у тестов нет — как не будет и у пары: dev может
 * оказаться недоступен, а копия оттуда мешает соседям. Поэтому здесь
 * закрепляется всё, что можно закрепить без него: собранные argv,
 * порядок шагов и то, что запись уходит только в локальные адреса.
 */

import { assert, expect, it } from "vitest";
import { DomainError, UsageError } from "../command/mod.ts";
import type { SqlOutcome } from "../sql/render.ts";
import type { SqlSession } from "../sql/session.ts";
import type { PgTarget } from "../sql/target.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { type DevIo, renderCopyDev, runCopyDev } from "./cmd_copy_dev.ts";

const ENV: Record<string, string> = {
  DEV_PG_USER: "dev_user",
  DEV_PG_PASSWORD: "dev-пароль",
  DEV_WORKSPACES_USER: "ws_user",
  DEV_WORKSPACES_PASSWORD: "ws-пароль",
  PG_MAIN_USER_PASSWORD: "локальный-пароль",
};

interface Tool {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const done: SqlOutcome = { kind: "done", rowcount: 0 };

function ioWith(env: Record<string, string> = ENV): DevIo {
  return makeFakeIo({
    progress: () => {},
    envFile: {
      get: (name: string) => env[name],
      require: (name: string) => {
        const value = env[name];
        if (value === undefined) {
          throw new DomainError(`environment variable ${name} is not set.`);
        }
        return value;
      },
      set: () => Promise.reject(new Error("не ожидается")),
      values: () => ({ ...env }),
    },
  });
}

function tools(codes: readonly number[], seen: Tool[]) {
  let call = 0;
  return (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    _onLine: (line: string) => void,
  ) => {
    seen.push({ argv: [...argv], env: { ...env } });
    return Promise.resolve({ code: codes[call++] ?? 0 });
  };
}

function sessions(ports: number[]) {
  return (target: PgTarget): Promise<SqlSession> => {
    ports.push(target.port);
    return Promise.resolve({
      query: (sql: string) =>
        Promise.resolve(
          sql.startsWith("SELECT")
            ? ({ kind: "rows", columns: ["id"], rows: [] } as SqlOutcome)
            : done,
        ),
      run: () => Promise.resolve(done),
      // Режим клиента гоняет тот же посев, что `copy-client`: список
      // операторов одной транзакцией.
      runMany: (statements: readonly unknown[]) =>
        Promise.resolve(statements.map(() => done)),
      close: () => Promise.resolve(),
    });
  };
}

it("режим полной БД: дамп dev-воркспейсов → локальный mp-sw-pg", async () => {
  const seen: Tool[] = [];
  const removed: string[] = [];
  const result = await runCopyDev({ client: undefined }, ioWith(), {
    runTool: tools([0, 0], seen),
    tempFile: () => "/tmp/проба.dump",
    removeFile: (path) => void removed.push(path),
    nowMs: () => 0,
  });

  expect(result.mode).toBe("workspaces");
  expect(seen.map((tool) => tool.argv[0])).toStrictEqual([
    "pg_dump",
    "pg_restore",
  ]);
  // Источник — dev, приёмник — только локальный адрес.
  expect(seen[0].argv.includes("192.168.150.41")).toBe(true);
  expect(seen[1].argv.includes("127.0.0.1")).toBe(true);
  expect(seen[1].argv.includes("5451")).toBe(true);
  // Локальные объекты сносятся перед восстановлением — это назначение
  // команды, а не побочный эффект.
  expect(seen[1].argv.includes("--clean")).toBe(true);
  expect(seen[1].argv.includes("--if-exists")).toBe(true);
  expect(removed).toStrictEqual(["/tmp/проба.dump"]);
  // Пароли уходят окружением: argv виден в `ps`.
  expect(seen[0].env.PGPASSWORD).toBe("ws-пароль");
  expect(seen[0].argv.includes("ws-пароль")).toBe(false);
});

it("режим клиента: та же машинерия, источник — dev", async () => {
  const seen: Tool[] = [];
  const ports: number[] = [];
  const result = await runCopyDev({ client: 776 }, ioWith(), {
    runTool: tools([0, 0], seen),
    openSession: sessions(ports),
    tempFile: () => "/tmp/проба.dump",
    removeFile: () => {},
    nowMs: () => 0,
  });

  expect([result.mode, result.clientId]).toStrictEqual(["client", 776]);
  expect(seen[0].argv.includes("-n")).toBe(true);
  expect(seen[0].argv.includes("schema_776")).toBe(true);
  // Источник dev sl-PG, приёмники — локальные sl-1 и sl-0.
  expect(seen[0].argv.includes("192.168.150.40")).toBe(true);
  expect([...new Set(ports)]).toStrictEqual([5441, 5434, 5440]);
});

it("отказ инструмента: код и последняя ошибка в сообщении", async () => {
  const err = await runCopyDev({ client: undefined }, ioWith(), {
    runTool: (_argv, _env, onLine) => {
      onLine("pg_dump: error: connection to server failed");
      return Promise.resolve({ code: 2 });
    },
    tempFile: () => "/tmp/проба.dump",
    removeFile: () => {},
    nowMs: () => 0,
  }).catch((thrown: unknown) => thrown);
  assert(err instanceof DomainError);
  expect(err.message).toContain("pg_dump workspaces failed (exit 2");
  expect(err.message).toContain("connection to server failed");
});

it("креды dev-воркспейсов обязательны, fallback'ов нет", async () => {
  const io = ioWith({ DEV_PG_USER: "dev_user", DEV_PG_PASSWORD: "п" });
  const failure = runCopyDev({ client: undefined }, io, {
    runTool: tools([0, 0], []),
    tempFile: () => "/tmp/проба.dump",
    removeFile: () => {},
    nowMs: () => 0,
  });
  await expect(failure).rejects.toThrow(UsageError);
  await expect(failure).rejects.toThrow("DEV_WORKSPACES_USER");
});

it("итог называет, что делать после копии", () => {
  expect(renderCopyDev({ mode: "workspaces", clientId: null })).toContain(
    "Перезапусти api",
  );
  expect(renderCopyDev({ mode: "client", clientId: 776 })).toContain(
    "✓ client 776: схема + public-строки → sl-1",
  );
});
