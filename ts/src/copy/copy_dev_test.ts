/**
 * Команда `mpu copy-dev` (`docs/specs/copy-dev.md`): два режима, общая
 * с `copy-client` машинерия и направление записи.
 *
 * Живого dev-стенда у тестов нет — как не будет и у пары: dev может
 * оказаться недоступен, а копия оттуда мешает соседям. Поэтому здесь
 * закрепляется всё, что можно закрепить без него: собранные argv,
 * порядок шагов и то, что запись уходит только в локальные адреса.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
      close: () => Promise.resolve(),
    });
  };
}

Deno.test("режим полной БД: дамп dev-воркспейсов → локальный mp-sw-pg", async () => {
  const seen: Tool[] = [];
  const removed: string[] = [];
  const result = await runCopyDev({ client: undefined }, ioWith(), {
    runTool: tools([0, 0], seen),
    tempFile: () => "/tmp/проба.dump",
    removeFile: (path) => void removed.push(path),
    nowMs: () => 0,
  });

  assertEquals(result.mode, "workspaces");
  assertEquals(seen.map((tool) => tool.argv[0]), ["pg_dump", "pg_restore"]);
  // Источник — dev, приёмник — только локальный адрес.
  assertEquals(seen[0].argv.includes("192.168.150.41"), true);
  assertEquals(seen[1].argv.includes("127.0.0.1"), true);
  assertEquals(seen[1].argv.includes("5451"), true);
  // Локальные объекты сносятся перед восстановлением — это назначение
  // команды, а не побочный эффект.
  assertEquals(seen[1].argv.includes("--clean"), true);
  assertEquals(seen[1].argv.includes("--if-exists"), true);
  assertEquals(removed, ["/tmp/проба.dump"]);
  // Пароли уходят окружением: argv виден в `ps`.
  assertEquals(seen[0].env.PGPASSWORD, "ws-пароль");
  assertEquals(seen[0].argv.includes("ws-пароль"), false);
});

Deno.test("режим клиента: та же машинерия, источник — dev", async () => {
  const seen: Tool[] = [];
  const ports: number[] = [];
  const result = await runCopyDev({ client: 776 }, ioWith(), {
    runTool: tools([0, 0], seen),
    openSession: sessions(ports),
    tempFile: () => "/tmp/проба.dump",
    removeFile: () => {},
    nowMs: () => 0,
  });

  assertEquals([result.mode, result.clientId], ["client", 776]);
  assertEquals(seen[0].argv.includes("-n"), true);
  assertEquals(seen[0].argv.includes("schema_776"), true);
  // Источник dev sl-PG, приёмники — локальные sl-1 и sl-0.
  assertEquals(seen[0].argv.includes("192.168.150.40"), true);
  assertEquals([...new Set(ports)], [5441, 5434, 5440]);
});

Deno.test("отказ инструмента: код и последняя ошибка в сообщении", async () => {
  const err = await assertRejects(
    () =>
      runCopyDev({ client: undefined }, ioWith(), {
        runTool: (_argv, _env, onLine) => {
          onLine("pg_dump: error: connection to server failed");
          return Promise.resolve({ code: 2 });
        },
        tempFile: () => "/tmp/проба.dump",
        removeFile: () => {},
        nowMs: () => 0,
      }),
    DomainError,
  );
  assertStringIncludes(err.message, "pg_dump workspaces failed (exit 2");
  assertStringIncludes(err.message, "connection to server failed");
});

Deno.test("креды dev-воркспейсов обязательны, fallback'ов нет", async () => {
  const io = ioWith({ DEV_PG_USER: "dev_user", DEV_PG_PASSWORD: "п" });
  await assertRejects(
    () =>
      runCopyDev({ client: undefined }, io, {
        runTool: tools([0, 0], []),
        tempFile: () => "/tmp/проба.dump",
        removeFile: () => {},
        nowMs: () => 0,
      }),
    UsageError,
    "DEV_WORKSPACES_USER",
  );
});

Deno.test("итог называет, что делать после копии", () => {
  assertStringIncludes(
    renderCopyDev({ mode: "workspaces", clientId: null }),
    "Перезапусти api",
  );
  assertStringIncludes(
    renderCopyDev({ mode: "client", clientId: 776 }),
    "✓ client 776: схема + public-строки → sl-1",
  );
});
