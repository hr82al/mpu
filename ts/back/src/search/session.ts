/**
 * Кэш сессий 10X (`docs/specs/search.md`, «HTTP и кэш токенов»): токен
 * живёт в кэш-БД парой «вид + субъект», срок годности берётся из самого
 * токена. Ни один вызов 10X не делается, пока годная сессия лежит рядом.
 *
 * Подпись JWT здесь не проверяется намеренно: токен выдан нам же, и
 * единственное, что из него нужно, — момент истечения. Проверять подпись
 * без ключа всё равно нечем.
 */

import type { CacheDb, SqlRow } from "../command/mod.ts";

/** Запас: сессия считается негодной за минуту до истечения (спека). */
const EXPIRY_MARGIN_SECONDS = 60;
/** Срок, когда `exp` из токена не извлёкся (спека). */
const FALLBACK_TTL_SECONDS = 600;

/** Вид сессии: под staff-кредами либо от лица клиента. */
export type SessionKind = "staff" | "impersonation";

/** Строка кэша сессий. */
export interface Session {
  readonly kind: SessionKind;
  /** Логин-email для staff, id цели строкой — для impersonation. */
  readonly subject: string;
  readonly token: string;
  readonly reason: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Годная сессия пары или `null`: протухшая равна отсутствию (спека). */
export function readSession(
  db: CacheDb,
  kind: SessionKind,
  subject: string,
  nowSeconds: number,
): Session | null {
  const rows = db.query(
    "SELECT kind, subject, token, reason, created_at, expires_at" +
      " FROM x10_sessions WHERE kind = ? AND subject = ?",
    kind,
    subject,
  );
  const row = rows[0];
  if (row === undefined) return null;
  const session = sessionOf(row);
  return session.expiresAt > nowSeconds ? session : null;
}

/** Кладёт сессию вместо прежней той же пары. */
export function writeSession(db: CacheDb, session: Session): void {
  db.execute(
    "INSERT INTO x10_sessions (kind, subject, token, reason, created_at," +
      " expires_at) VALUES (?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT(kind, subject) DO UPDATE SET token = excluded.token," +
      " reason = excluded.reason, created_at = excluded.created_at," +
      " expires_at = excluded.expires_at",
    session.kind,
    session.subject,
    session.token,
    session.reason,
    session.createdAt,
    session.expiresAt,
  );
}

/** Все сессии пары субъектов — для вывода команды (`sessions`). */
export function readAnySession(
  db: CacheDb,
  kind: SessionKind,
  subject: string,
): Session | null {
  const rows = db.query(
    "SELECT kind, subject, token, reason, created_at, expires_at" +
      " FROM x10_sessions WHERE kind = ? AND subject = ?",
    kind,
    subject,
  );
  return rows[0] === undefined ? null : sessionOf(rows[0]);
}

/**
 * Момент истечения токена: `exp` из payload JWT минус минута запаса. Не
 * извлёкся — фиксированные десять минут: без срока сессия либо не
 * переиспользовалась бы вовсе, либо жила бы вечно.
 */
export function expiresAtOf(token: string, nowSeconds: number): number {
  const exp = jwtExpiry(token);
  return exp === null
    ? nowSeconds + FALLBACK_TTL_SECONDS
    : exp - EXPIRY_MARGIN_SECONDS;
}

/** `exp` из payload JWT; форма не та — `null`, а не отказ. */
function jwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const exp = (payload as Record<string, unknown>).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

/** base64url → текст: `-`/`_` вместо `+`/`/`, выравнивание необязательно. */
function base64UrlDecode(raw: string): string {
  const padded = raw.replaceAll("-", "+").replaceAll("_", "/");
  const full = padded + "=".repeat((4 - padded.length % 4) % 4);
  return new TextDecoder().decode(
    Uint8Array.from(atob(full), (char) => char.charCodeAt(0)),
  );
}

function sessionOf(row: SqlRow): Session {
  return {
    kind: text(row.kind) as SessionKind,
    subject: text(row.subject),
    token: text(row.token),
    reason: typeof row.reason === "string" ? row.reason : null,
    createdAt: int(row.created_at),
    expiresAt: int(row.expires_at),
  };
}

function text(value: SqlRow[string]): string {
  return typeof value === "string" ? value : "";
}

function int(value: SqlRow[string]): number {
  return typeof value === "number" ? value : 0;
}
