/**
 * Значения `target:` для дополнения (`platform/reflection.md`,
 * «Значения ключа»): dev-клиенты, предел, пустой кэш.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openCacheDb } from "../store/mod.ts";
import { targetValues } from "./mod.ts";

async function withClients(
  count: number,
  body: (cache: ReturnType<typeof openCacheDb>) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    for (let id = 1; id <= count; id++) {
      db.execute(
        "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
          " is_deleted, synced_at) VALUES (?, 'sl-1', 1, 0, 0, 0)",
        id,
      );
    }
    body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

it("dev: — клиенты с приставкой dev:", () =>
  withClients(3, (cache) => {
    expect(targetValues(cache, "dev:2")).toStrictEqual([
      { value: "dev:2", purpose: "sl-1" },
    ]);
  }));

it("не больше двадцати, по алфавиту", () =>
  withClients(30, (cache) => {
    const found = targetValues(cache, "");
    expect(found.length).toBe(20);
    expect(found.map((one) => one.value)).toStrictEqual(
      found.map((one) => one.value).sort(),
    );
  }));

it("кэш не проинициализирован — значений нет", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    expect(targetValues(db, "1")).toStrictEqual([]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
