/**
 * Значения `target:` для дополнения (`platform/reflection.md`,
 * «Значения ключа»): dev-клиенты, предел, пустой кэш.
 */

import { assertEquals } from "@std/assert";
import { openCacheDb } from "../store/mod.ts";
import { targetValues } from "./mod.ts";

async function withClients(
  count: number,
  body: (cache: ReturnType<typeof openCacheDb>) => void,
) {
  const dir = await Deno.makeTempDir();
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
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("dev: — клиенты с приставкой dev:", () =>
  withClients(3, (cache) => {
    assertEquals(targetValues(cache, "dev:2"), [
      { value: "dev:2", purpose: "sl-1" },
    ]);
  }));

Deno.test("не больше двадцати, по алфавиту", () =>
  withClients(30, (cache) => {
    const found = targetValues(cache, "");
    assertEquals(found.length, 20);
    assertEquals(
      found.map((one) => one.value),
      found.map((one) => one.value).sort(),
    );
  }));

Deno.test("кэш не проинициализирован — значений нет", async () => {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    assertEquals(targetValues(db, "1"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
