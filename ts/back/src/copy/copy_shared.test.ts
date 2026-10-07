/**
 * Команда `mpu copy-shared` (`docs/specs/copy-shared.md`): собранная
 * локальная команда и проброс кода переносящего процесса.
 *
 * Своей копии данных у команды нет — перенос делает `pgDataTransfer` в
 * контейнере dt-host, — поэтому проверяется именно argv: состав и
 * порядок env-файлов, целевой порт и список таблиц.
 */

import { assert, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../command/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  composeArgs,
  runCopyShared,
  SHARED_TABLES,
  type SharedIo,
} from "./cmd_copy_shared.ts";

const CONFIG = "/стенд/mp-config-local";

const ENV: Record<string, string> = { pg_1: "pg-prod-1.example.test" };

async function withIo(
  body: (io: SharedIo) => Promise<void>,
  overrides: Partial<Record<string, string>> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    const io = makeFakeIo({
      env: (name: string) =>
        ({ HOME: "/дом", MPU_MP_CONFIG_LOCAL: CONFIG, ...overrides })[name],
      openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
      progress: () => {},
      stdinIsTerminal: () => false,
      envFile: {
        get: (name: string) => ENV[name],
        require: (name: string) => ENV[name] ?? "",
        set: () => Promise.reject(new Error("не ожидается")),
        values: () => ({ ...ENV }),
      },
    });
    await body(io);
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe("argv: env-файлы по порядку, цель и список таблиц", () => {
  const argv = composeArgs(CONFIG, "pg-prod-1.example.test", false, () => true);

  it("env-файлы в порядке спеки", () => {
    const envFiles = argv.filter((_, index) =>
      argv[index - 1] === "--env-file"
    );
    expect(envFiles).toStrictEqual([
      `${CONFIG}/.sl-base.env`,
      `${CONFIG}/.env`,
      `${CONFIG}/.sl-dt.base.env`,
      `${CONFIG}/.sl-dt.env`,
    ]);
  });

  it("необязательные включаются только при наличии", () => {
    const lean = composeArgs(
      CONFIG,
      "pg-prod-1.example.test",
      false,
      (path) => !path.endsWith(".env") || path.endsWith("base.env"),
    );
    const envFiles = lean.filter((_, index) =>
      lean[index - 1] === "--env-file"
    );
    // Базовые остаются всегда: их отсутствие обязано быть отказом
    // compose'а, а не тихой недостачей переменных.
    expect(envFiles).toStrictEqual([
      `${CONFIG}/.sl-base.env`,
      `${CONFIG}/.sl-dt.base.env`,
    ]);
  });

  it("inner-команда: цель, схема и очистка", () => {
    const inner = argv[argv.length - 1];
    expect(inner).toContain("--s-host=pg-prod-1.example.test");
    expect(inner).toContain("--s-port=5432");
    // Целевой порт зашит: настраиваемая цель провоцировала бы очистку
    // чужой БД (отклонение preserve спеки).
    expect(inner).toContain("--t-port 5441");
    expect(inner).toContain("--schema shared");
    expect(inner).toContain("--clear-tables");
  });

  it("все 18 таблиц в порядке спеки", () => {
    const inner = argv[argv.length - 1];
    const tables = inner.slice(inner.indexOf("--tables ") + 9).split(" ");
    expect(tables).toStrictEqual([...SHARED_TABLES]);
    expect(tables.length).toBe(18);
  });

  it("без терминала -i, с терминалом -it", () => {
    expect(argv.includes("-i")).toBe(true);
    expect(argv.includes("-it")).toBe(false);
    const tty = composeArgs(CONFIG, "host", true, () => true);
    expect(tty.includes("-it")).toBe(true);
  });
});

it("код переносящего процесса доносится 1:1", async () => {
  await withIo(async (io) => {
    for (const code of [0, 3, 17]) {
      const result = await runCopyShared({ selector: "sl-1" }, io, {
        runLocal: () => Promise.resolve(code),
        exists: () => true,
      });
      expect(result.exitCode).toStrictEqual(code);
    }
  });
});

it("команда печатается перед запуском", async () => {
  const lines: string[] = [];
  await withIo(async (io) => {
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    await runCopyShared({ selector: "sl-1" }, loud, {
      runLocal: () => Promise.resolve(0),
      exists: () => true,
    });
  });
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("$ docker compose --env-file");
  expect(lines[0]).toContain("pgDataTransfer.js");
});

describe("отказы конфигурации — до запуска docker", () => {
  it("нет pg_<N> сервера", async () => {
    await withIo(async (io) => {
      const bare = {
        ...io,
        envFile: { ...io.envFile, get: () => undefined },
      };
      const failure = runCopyShared({ selector: "sl-1" }, bare, {
        runLocal: () => Promise.reject(new Error("docker не ожидается")),
        exists: () => true,
      });
      await expect(failure).rejects.toThrow(UsageError);
      await expect(failure).rejects.toThrow(
        "pg_1 not found in ~/.config/mpu/.env",
      );
    });
  });

  it("нет каталога mp-config-local", async () => {
    await withIo(async (io) => {
      const err = await runCopyShared({ selector: "sl-1" }, io, {
        runLocal: () => Promise.reject(new Error("docker не ожидается")),
        exists: () => false,
      }).catch((thrown: unknown) => thrown);
      assert(err instanceof UsageError);
      expect(err.message).toContain(`mp-config-local dir not found: ${CONFIG}`);
      expect(String(err.hint)).toContain("MPU_MP_CONFIG_LOCAL");
    });
  });

  it("нет compose-файла", async () => {
    await withIo(async (io) => {
      const failure = runCopyShared({ selector: "sl-1" }, io, {
        runLocal: () => Promise.reject(new Error("docker не ожидается")),
        exists: (path) => !path.endsWith("compose.sl-dt-host.yaml"),
      });
      await expect(failure).rejects.toThrow(UsageError);
      await expect(failure).rejects.toThrow("compose file not found:");
    });
  });
});
