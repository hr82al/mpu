/**
 * Кэш сессий 10X (`docs/specs/search.md`, «HTTP и кэш токенов»):
 * `expiresAtOf` разбирает `exp` из JWT без проверки подписи, а
 * `readSession`/`writeSession` работают с настоящей кэш-БД во временном
 * каталоге (как `cmd_search_test.ts`) — протухшая сессия равна
 * отсутствию (мутационная точка).
 */

import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheDb } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import {
  expiresAtOf,
  readSession,
  type Session,
  writeSession,
} from "./session.ts";

/** JWT с заданным payload; подпись — произвольная строка, её никто не проверяет. */
function jwtWith(payload: Record<string, unknown>): string {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function withDb(body: (db: CacheDb) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    body(db);
  } finally {
    await rm(dir, { recursive: true });
  }
}

/* --------------------------------------------------------------- *
 * expiresAtOf
 * --------------------------------------------------------------- */

it("expiresAtOf: exp валидного JWT минус 60 секунд", () => {
  const token = jwtWith({ exp: 1_700_001_000 });
  expect(expiresAtOf(token, 1_700_000_000)).toStrictEqual(1_700_001_000 - 60);
});

it("expiresAtOf: не-JWT (не три части) — сейчас плюс 600", () => {
  expect(expiresAtOf("не-токен-вовсе", 1_700_000_000)).toStrictEqual(
    1_700_000_000 + 600,
  );
});

it("expiresAtOf: битый payload JWT (не base64url JSON) — сейчас плюс 600", () => {
  const token = `${b64url("{}")}.не-base64-json.sig`;
  expect(expiresAtOf(token, 1_700_000_000)).toStrictEqual(1_700_000_000 + 600);
});

it("expiresAtOf: payload без числового exp — сейчас плюс 600", () => {
  const token = jwtWith({ exp: "не число" });
  expect(expiresAtOf(token, 1_700_000_000)).toStrictEqual(1_700_000_000 + 600);
});

/* --------------------------------------------------------------- *
 * readSession / writeSession
 * --------------------------------------------------------------- */

it("writeSession + readSession: годная сессия читается как записана", async () => {
  await withDb((db) => {
    const session: Session = {
      kind: "staff",
      subject: "ops@example.com",
      token: "tok-1",
      reason: null,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_001_000,
    };
    writeSession(db, session);
    expect(
      readSession(db, "staff", "ops@example.com", 1_700_000_500),
    ).toStrictEqual(session);
  });
});

it("readSession: протухшая сессия равна отсутствию (null)", async () => {
  // Мутационная точка: `expiresAt > nowSeconds`, не `>=` — сессия,
  // истёкшая ровно в эту секунду, уже негодна.
  await withDb((db) => {
    writeSession(db, {
      kind: "staff",
      subject: "ops@example.com",
      token: "tok-1",
      reason: null,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_000_500,
    });
    expect(
      readSession(db, "staff", "ops@example.com", 1_700_000_500),
    ).toStrictEqual(null);
    expect(
      readSession(db, "staff", "ops@example.com", 1_700_000_600),
    ).toStrictEqual(null);
  });
});

it("readSession: строки пары нет — null", async () => {
  await withDb((db) => {
    expect(
      readSession(db, "impersonation", "555", 1_700_000_000),
    ).toStrictEqual(null);
  });
});

it("writeSession: перезаписывает строку той же пары (kind, subject)", async () => {
  await withDb((db) => {
    writeSession(db, {
      kind: "impersonation",
      subject: "555",
      token: "tok-старый",
      reason: "ТП 2026-08-01",
      createdAt: 1_700_000_000,
      expiresAt: 1_700_001_000,
    });
    writeSession(db, {
      kind: "impersonation",
      subject: "555",
      token: "tok-новый",
      reason: "ТП 2026-08-19",
      createdAt: 1_700_002_000,
      expiresAt: 1_700_003_000,
    });
    const rows = db.query("SELECT COUNT(*) AS n FROM x10_sessions");
    expect(rows[0].n).toBe(1);
    expect(
      readSession(db, "impersonation", "555", 1_700_002_500),
    ).toStrictEqual({
      kind: "impersonation",
      subject: "555",
      token: "tok-новый",
      reason: "ТП 2026-08-19",
      createdAt: 1_700_002_000,
      expiresAt: 1_700_003_000,
    });
  });
});
