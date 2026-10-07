/**
 * Стенд сценариев `call` (`docs/specs/call.md`, «Сценарии 173a–173c»):
 * env-файл и настоящая кэш-БД селектора во временном файле. Только для
 * тестов модуля.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CacheDb, DomainError, type EnvFile } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";

/** Адрес и креды PG сервера sl-1 стенда. */
export const ENV: Readonly<Record<string, string>> = {
  pg_1: "10.0.0.1",
  PG_MY_USER_NAME: "u",
  PG_MY_USER_PASSWORD: "p",
};

/** Env-файл из готовых значений; запись не ожидается. */
export function envFileOf(values: Readonly<Record<string, string>>): EnvFile {
  return {
    get: (name) => values[name],
    values: () => ({ ...values }),
    require: (name) => {
      const value = values[name];
      if (value !== undefined) return value;
      throw new DomainError(`environment variable ${name} is not set`);
    },
    set: () => Promise.reject(new Error("запись env-файла не ожидается")),
  };
}

/** Кэш-БД селектора: клиенты 54–58 на sl-1. */
export async function withCache(body: (open: () => CacheDb) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const path = `${dir}/mpu.db`;
  try {
    {
      using seed = openCacheDb(path);
      seed.bootstrap();
      for (const id of [54, 55, 56, 57, 58]) {
        seed.execute(
          "INSERT INTO sl_clients (client_id, server, is_active, is_locked," +
            " is_deleted, synced_at) VALUES (?, 'sl-1', 1, 0, 0, 0)",
          id,
        );
      }
    }
    await body(() => openCacheDb(path));
  } finally {
    await rm(dir, { recursive: true });
  }
}
