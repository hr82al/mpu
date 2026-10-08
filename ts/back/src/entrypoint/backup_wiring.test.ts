/**
 * Вплетение `mpu backup-*` (`docs/specs/backup.md`) в точку входа: при
 * `--dry` stdout пуст, а мета-блок печатает точка входа. Прогон идёт
 * через `runCli`; прочие тесты команды — в пакете `@mpu/cmd-backup`.
 * Эталон — из канала спецификаций: папку пакета `ts/` не читает.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CacheDb } from "@mpu/command";
import { openCacheDb } from "@mpu/command/store";
import { makeFakeIo } from "@mpu/command/testing";
import { runCli } from "./mod.ts";

/** Синтетический конфиг: девятый сервер, свой хост и порт. */
const ENV: Readonly<Record<string, string>> = {
  pg_9: "10.9.9.9",
  PG_PORT: "5432",
  PG_DB_NAME: "mp",
  PG_MY_USER_NAME: "probeuser",
  PG_MY_USER_PASSWORD: "проба",
};

const CLIENT = { id: 777, server: "sl-9", sheet: "SHEET123" };

/** Кэш-БД с одним клиентом и одной его таблицей. */
async function withCache(body: (db: CacheDb) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    db.execute(
      "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
        " is_deleted, synced_at) VALUES (?, ?, 1, 0, 0, ?)",
      CLIENT.id,
      CLIENT.server,
      1_700_000_000,
    );
    db.execute(
      "INSERT INTO sl_spreadsheets (ss_id, client_id, title, is_active," +
        " server, synced_at) VALUES (?, ?, ?, 1, ?, ?)",
      `${CLIENT.sheet}-0`,
      CLIENT.id,
      "Таблица 0",
      CLIENT.server,
      1_700_000_000,
    );
    await body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** Порт вызова над кэш-БД и env-файлом стенда; записи не ожидается. */
function io(db: CacheDb) {
  return makeFakeIo({
    envFile: {
      get: (name: string) => ENV[name],
      require: (name: string) => {
        const value = ENV[name];
        if (value === undefined) throw new Error(`нет ключа ${name}`);
        return value;
      },
      set: () => Promise.reject(new Error("запись env-файла не ожидается")),
      values: () => ({ ...ENV }),
    },
    openCacheDb: () => ({ ...db, [Symbol.dispose]: () => {} }),
  });
}

it("по CLI: stdout пуст, блок печатает точка входа", async () => {
  // Проверка наблюдаемого: сам поток выбирает не команда, а точка
  // входа, и утверждение пакета о `renderResult` о ней ничего не знает.
  await withCache(async (db) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ["backup-wb-unit-proto", "777", "--date", "20260827", "--dry"],
      io(db),
      {
        stdout: (text) => void out.push(text),
        stderr: (text) => void err.push(text),
      },
    );
    expect(code).toBe(0);
    expect(out.join(""), "stdout не пуст").toBe("");
    const golden = await readFile(
      new URL(
        "../../../docs/specs/fixtures/backup/backup-dry-stderr.txt",
        import.meta.url,
      ),
      "utf8",
    );
    expect(err.join("")).toStrictEqual(golden);
  });
});
