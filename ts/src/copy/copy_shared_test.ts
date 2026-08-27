/**
 * Команда `mpu copy-shared` (`docs/specs/copy-shared.md`): собранная
 * локальная команда и проброс кода переносящего процесса.
 *
 * Своей копии данных у команды нет — перенос делает `pgDataTransfer` в
 * контейнере dt-host, — поэтому проверяется именно argv: состав и
 * порядок env-файлов, целевой порт и список таблиц.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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
  const dir = await Deno.makeTempDir();
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
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("argv: env-файлы по порядку, цель и список таблиц", async (t) => {
  const argv = composeArgs(CONFIG, "pg-prod-1.example.test", false, () => true);

  await t.step("env-файлы в порядке спеки", () => {
    const envFiles = argv.filter((_, index) =>
      argv[index - 1] === "--env-file"
    );
    assertEquals(envFiles, [
      `${CONFIG}/.sl-base.env`,
      `${CONFIG}/.env`,
      `${CONFIG}/.sl-dt.base.env`,
      `${CONFIG}/.sl-dt.env`,
    ]);
  });

  await t.step("необязательные включаются только при наличии", () => {
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
    assertEquals(envFiles, [
      `${CONFIG}/.sl-base.env`,
      `${CONFIG}/.sl-dt.base.env`,
    ]);
  });

  await t.step("inner-команда: цель, схема и очистка", () => {
    const inner = argv[argv.length - 1];
    assertStringIncludes(inner, "--s-host=pg-prod-1.example.test");
    assertStringIncludes(inner, "--s-port=5432");
    // Целевой порт зашит: настраиваемая цель провоцировала бы очистку
    // чужой БД (отклонение preserve спеки).
    assertStringIncludes(inner, "--t-port 5441");
    assertStringIncludes(inner, "--schema shared");
    assertStringIncludes(inner, "--clear-tables");
  });

  await t.step("все 18 таблиц в порядке спеки", () => {
    const inner = argv[argv.length - 1];
    const tables = inner.slice(inner.indexOf("--tables ") + 9).split(" ");
    assertEquals(tables, [...SHARED_TABLES]);
    assertEquals(tables.length, 18);
  });

  await t.step("без терминала -i, с терминалом -it", () => {
    assertEquals(argv.includes("-i"), true);
    assertEquals(argv.includes("-it"), false);
    const tty = composeArgs(CONFIG, "host", true, () => true);
    assertEquals(tty.includes("-it"), true);
  });
});

Deno.test("код переносящего процесса доносится 1:1", async () => {
  await withIo(async (io) => {
    for (const code of [0, 3, 17]) {
      const result = await runCopyShared({ selector: "sl-1" }, io, {
        runLocal: () => Promise.resolve(code),
        exists: () => true,
      });
      assertEquals(result.exitCode, code);
    }
  });
});

Deno.test("команда печатается перед запуском", async () => {
  const lines: string[] = [];
  await withIo(async (io) => {
    const loud = { ...io, progress: (line: string) => void lines.push(line) };
    await runCopyShared({ selector: "sl-1" }, loud, {
      runLocal: () => Promise.resolve(0),
      exists: () => true,
    });
  });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "$ docker compose --env-file");
  assertStringIncludes(lines[0], "pgDataTransfer.js");
});

Deno.test("отказы конфигурации — до запуска docker", async (t) => {
  await t.step("нет pg_<N> сервера", async () => {
    await withIo(async (io) => {
      const bare = {
        ...io,
        envFile: { ...io.envFile, get: () => undefined },
      };
      await assertRejects(
        () =>
          runCopyShared({ selector: "sl-1" }, bare, {
            runLocal: () => Promise.reject(new Error("docker не ожидается")),
            exists: () => true,
          }),
        UsageError,
        "pg_1 not found in ~/.config/mpu/.env",
      );
    });
  });

  await t.step("нет каталога mp-config-local", async () => {
    await withIo(async (io) => {
      const err = await assertRejects(
        () =>
          runCopyShared({ selector: "sl-1" }, io, {
            runLocal: () => Promise.reject(new Error("docker не ожидается")),
            exists: () => false,
          }),
        UsageError,
        `mp-config-local dir not found: ${CONFIG}`,
      );
      assertStringIncludes(String(err.hint), "MPU_MP_CONFIG_LOCAL");
    });
  });

  await t.step("нет compose-файла", async () => {
    await withIo(async (io) => {
      await assertRejects(
        () =>
          runCopyShared({ selector: "sl-1" }, io, {
            runLocal: () => Promise.reject(new Error("docker не ожидается")),
            exists: (path) => !path.endsWith("compose.sl-dt-host.yaml"),
          }),
        UsageError,
        "compose file not found:",
      );
    });
  });
});
