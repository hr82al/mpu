/**
 * Полная перезапись кэша `writeLokiCache` поверх настоящей SQLite-БД
 * (`docs/specs/platform/loki-http.md`, «Инварианты»). Клиент Loki и его
 * тесты — библиотека `@mpu/loki`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { plainRows } from "../testing/cache.ts";
import { openCacheDb } from "../store/mod.ts";
import { writeLokiCache } from "./mod.ts";

/** Временная кэш-БД с готовой схемой; уборка каталога — в `finally`. */
async function withBootstrappedDb(
  fn: (dbPath: string) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const dbPath = `${dir}/mpu.db`;
    using db = openCacheDb(dbPath);
    db.bootstrap();
    await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true });
  }
}

it("writeLokiCache: полная перезапись обеих таблиц одной транзакцией", async () => {
  await withBootstrappedDb((dbPath) => {
    using db = openCacheDb(dbPath);

    writeLokiCache(
      db,
      {
        hosts: ["sl-1", "sl-2"],
        pairs: [{ host: "sl-1", service: "api" }],
      },
      1_000,
    );

    expect(
      plainRows(
        db.query("SELECT host, discovered_at FROM loki_hosts ORDER BY host"),
      ),
    ).toStrictEqual([
      { host: "sl-1", discovered_at: 1_000 },
      { host: "sl-2", discovered_at: 1_000 },
    ]);
    expect(
      plainRows(
        db.query(
          "SELECT host, service, discovered_at FROM loki_services_by_host ORDER BY host, service",
        ),
      ),
    ).toStrictEqual([{ host: "sl-1", service: "api", discovered_at: 1_000 }]);

    // Второй вызов с другим набором — полная перезапись: старых строк не
    // остаётся (инвариант спеки, `platform/loki-http.md`, «Инварианты»).
    writeLokiCache(
      db,
      {
        hosts: ["wb-1"],
        pairs: [],
      },
      2_000,
    );

    expect(
      plainRows(
        db.query("SELECT host, discovered_at FROM loki_hosts ORDER BY host"),
      ),
    ).toStrictEqual([{ host: "wb-1", discovered_at: 2_000 }]);
    expect(
      plainRows(
        db.query(
          "SELECT host, service, discovered_at FROM loki_services_by_host",
        ),
      ),
    ).toStrictEqual([]);
  });
});
