/**
 * Стенд сценариев `call` (`docs/specs/call.md`, «Сценарии 173a–173c»):
 * env-файл, настоящая кэш-БД селектора во временном файле и БД клиента
 * получателя `wb` — токены кабинетов и ответ WB. Только для тестов:
 * пакета и теста строки `ts/` (вход `@mpu/cmd-call/testing`).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CacheDb, DomainError, type EnvFile } from "@mpu/command";
import { openCacheDb } from "@mpu/command/store";
import type { OpenSession } from "@mpu/cmd-sql";

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

/** Строка `public.wb_tokens` стенда. */
export interface WbTokenRow {
  readonly sid: string;
  readonly token: string;
  readonly categories: readonly string[];
  readonly readOnly: boolean;
  readonly valid: boolean;
  /** Сервисный токен (`acc = 4`). */
  readonly service: boolean;
}

/** Токены `wb` стенда по клиентам (`docs/specs/call.md`, W1–W14). */
export const WB_TOKENS: Readonly<Record<number, readonly WbTokenRow[]>> = {
  57: [
    row("sid-a", "w-ro", ["statistics"], { readOnly: true }),
    row("sid-a", "w-rw", ["statistics"]),
    row("sid-a", "w-bad", ["content"], { valid: false }),
  ],
  58: [
    row("sid-a", "w-58-a", ["statistics"]),
    row("sid-b", "w-58-b", ["content"]),
  ],
  // W11, W12: у кабинета только сервисные токены statistics.
  56: [row("sid-a", "w-svc", ["statistics"], { service: true })],
  // W13: сервисный и несервисный токены statistics.
  55: [
    row("sid-a", "w-svc-55", ["statistics"], { service: true }),
    row("sid-a", "w-plain-55", ["statistics"]),
  ],
};

function row(
  sid: string,
  token: string,
  categories: readonly string[],
  given: {
    readonly readOnly?: boolean;
    readonly valid?: boolean;
    readonly service?: boolean;
  } = {},
): WbTokenRow {
  const { readOnly = false, valid = true, service = false } = given;
  return { sid, token, categories, readOnly, valid, service };
}

/** Ответ заглушки WB по умолчанию: пустой список и квота. */
export function wbReply(): Response {
  return new Response("[]", {
    status: 200,
    headers: { "x-ratelimit-remaining": "9", "x-ratelimit-limit": "10" },
  });
}

/**
 * Сессия БД клиента стенда `wb`: строки `WB_TOKENS` клиента из параметра
 * запроса (каждый запрос пишется в `queries`); `fits` — по колонке
 * категории, названной в запросе (`true` — любая).
 */
export function wbSessions(
  queries: [string, readonly unknown[]][],
): OpenSession {
  return () =>
    Promise.resolve({
      query: (text: string, params: readonly unknown[] = []) => {
        queries.push([text, params]);
        const column = /(\S+) AS fits/.exec(text)?.[1] ?? "";
        const fits = (one: WbTokenRow) =>
          column === "true" || one.categories.includes(column.slice(1, -1));
        const rows = WB_TOKENS[Number(params[0])] ?? [];
        return Promise.resolve({
          kind: "rows" as const,
          columns: ["sid", "token", "read_only", "usable", "fits", "service"],
          rows: rows.map((one) => [
            one.sid,
            one.token,
            one.readOnly,
            one.valid,
            fits(one),
            one.service,
          ]),
        });
      },
      run: () => Promise.reject(new Error("run не ожидается")),
      runMany: () => Promise.reject(new Error("runMany не ожидается")),
      close: () => Promise.resolve(),
    });
}
