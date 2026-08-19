/**
 * Кэш сессий 10X (`docs/specs/search.md`, «HTTP и кэш токенов»):
 * `expiresAtOf` разбирает `exp` из JWT без проверки подписи, а
 * `readSession`/`writeSession` работают с настоящей кэш-БД во временном
 * каталоге (как `cmd_search_test.ts`) — протухшая сессия равна
 * отсутствию (мутационная точка).
 */

import { assertEquals } from "@std/assert";
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
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

async function withDb(body: (db: CacheDb) => void): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    using db = openCacheDb(`${dir}/mpu.db`);
    db.bootstrap();
    body(db);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/* --------------------------------------------------------------- *
 * expiresAtOf
 * --------------------------------------------------------------- */

Deno.test("expiresAtOf: exp валидного JWT минус 60 секунд", () => {
  const token = jwtWith({ exp: 1_700_001_000 });
  assertEquals(expiresAtOf(token, 1_700_000_000), 1_700_001_000 - 60);
});

Deno.test("expiresAtOf: не-JWT (не три части) — сейчас плюс 600", () => {
  assertEquals(
    expiresAtOf("не-токен-вовсе", 1_700_000_000),
    1_700_000_000 + 600,
  );
});

Deno.test("expiresAtOf: битый payload JWT (не base64url JSON) — сейчас плюс 600", () => {
  const token = `${b64url("{}")}.не-base64-json.sig`;
  assertEquals(expiresAtOf(token, 1_700_000_000), 1_700_000_000 + 600);
});

Deno.test("expiresAtOf: payload без числового exp — сейчас плюс 600", () => {
  const token = jwtWith({ exp: "не число" });
  assertEquals(expiresAtOf(token, 1_700_000_000), 1_700_000_000 + 600);
});

/* --------------------------------------------------------------- *
 * readSession / writeSession
 * --------------------------------------------------------------- */

Deno.test("writeSession + readSession: годная сессия читается как записана", async () => {
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
    assertEquals(
      readSession(db, "staff", "ops@example.com", 1_700_000_500),
      session,
    );
  });
});

Deno.test("readSession: протухшая сессия равна отсутствию (null)", async () => {
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
    assertEquals(
      readSession(db, "staff", "ops@example.com", 1_700_000_500),
      null,
    );
    assertEquals(
      readSession(db, "staff", "ops@example.com", 1_700_000_600),
      null,
    );
  });
});

Deno.test("readSession: строки пары нет — null", async () => {
  await withDb((db) => {
    assertEquals(readSession(db, "impersonation", "555", 1_700_000_000), null);
  });
});

Deno.test("writeSession: перезаписывает строку той же пары (kind, subject)", async () => {
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
    assertEquals(rows[0].n, 1);
    assertEquals(readSession(db, "impersonation", "555", 1_700_002_500), {
      kind: "impersonation",
      subject: "555",
      token: "tok-новый",
      reason: "ТП 2026-08-19",
      createdAt: 1_700_002_000,
      expiresAt: 1_700_003_000,
    });
  });
});
