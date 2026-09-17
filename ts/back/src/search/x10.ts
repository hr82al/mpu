/**
 * Ветка 10X команды `mpu search` (`docs/specs/search.md`): staff-логин,
 * staff-поиск, impersonation и список воркспейсов цели. Порядок вызовов
 * задан спекой и не меняется; сеть трогается только там, где кэш не
 * ответил.
 *
 * Правило выбора кандидата живёт здесь же, рядом с вызовом: оно —
 * единственная защита от входа не в тот аккаунт (staff-поиск отвечает
 * подстрочными совпадениями, а impersonate пишет прод-аудит).
 */

import { type CacheDb, DomainError, type SqlRow } from "../command/mod.ts";
import {
  type EnvKeys,
  x10Call,
  type X10Send,
  X10StatusError,
} from "./x10_http.ts";
import {
  expiresAtOf,
  readSession,
  type Session,
  type SessionKind,
  writeSession,
} from "./session.ts";

/** Кандидат staff-поиска: то, что из ответа нужно правилу выбора. */
export interface StaffUser {
  readonly id: number;
  readonly email: string;
  readonly name: string | null;
  readonly isEmailVerified: boolean;
  /** Совпадение по воркспейсу; приходит только при `scope=access`. */
  readonly match: Readonly<Record<string, unknown>> | null;
}

/** Что ветке нужно от окружения. */
export interface X10Deps {
  readonly db: CacheDb;
  readonly env: EnvKeys;
  readonly baseUrl: string;
  readonly send?: X10Send;
  /** Текущий момент в unix-секундах: сроки сессий считаются от него. */
  readonly nowSeconds: number;
  /** Путь env-файла — только для текста отказа о недостающих кредах. */
  readonly envFilePath: string;
}

/**
 * Staff-сессия: годная из кэша либо новая логином. Субъект пары —
 * логин-email, а не цель: staff-токен один на все цели.
 */
export async function staffToken(deps: X10Deps): Promise<string> {
  const login = requireCred(deps, "X10_LOGIN");
  const cached = readSession(deps.db, "staff", login, deps.nowSeconds);
  if (cached !== null) return cached.token;
  const password = requireCred(deps, "X10_PASSWORD");
  const data = await call(deps, {
    method: "POST",
    path: "/auth/login",
    body: { email: login, password },
  });
  const token = accessToken(data, "10X login");
  remember(deps, "staff", login, token, null);
  return token;
}

/**
 * Staff-поиск. `scope` не задан — запрос без него (email-ветка); задан —
 * уходит параметром. Порядок ответа сервером не задан, и правило выбора
 * на него не опирается.
 */
export async function staffSearch(
  deps: X10Deps,
  token: string,
  query: string,
  scope?: string,
): Promise<readonly StaffUser[]> {
  const suffix = scope === undefined
    ? ""
    : `&scope=${encodeURIComponent(scope)}`;
  const data = await call(deps, {
    method: "GET",
    path: `/users/staff/search?query=${encodeURIComponent(query)}${suffix}`,
    token,
  });
  // Метка ветки нужна только текстам отказа: в селекторной ветке спека
  // требует `(scope=<eff>)`, в email-ветке — без него.
  const where = scope === undefined
    ? "10X staff search"
    : `10X staff search (scope=${scope})`;
  return Array.isArray(data)
    ? data.map((raw) => staffUserOf(raw, where)).filter(isUser)
    : [];
}

/**
 * Кандидат для impersonation: точная почта, иначе владельцы, иначе весь
 * пул; в отобранном ровно один — он и берётся, какой бы ни была роль.
 * Подстрочное совпадение почты кандидатом не делает: impersonate ушёл бы
 * не в тот аккаунт, а он пишет прод-аудит.
 */
export function pickCandidate(
  users: readonly StaffUser[],
  value: string,
): { readonly user: StaffUser } | { readonly ambiguous: readonly StaffUser[] } {
  const exact = users.filter(
    (user) => user.email.toLowerCase() === value.toLowerCase(),
  );
  if (exact.length === 1) return { user: exact[0] };
  const pool = exact.length > 1 ? exact : owners(users, users);
  if (pool.length === 1) return { user: pool[0] };
  return { ambiguous: pool };
}

/** Кандидаты-владельцы; их нет — в отбор идут все пригодные (спека). */
function owners(
  users: readonly StaffUser[],
  fallback: readonly StaffUser[],
): readonly StaffUser[] {
  const found = users.filter((user) => roleOf(user) === "owner");
  return found.length > 0 ? found : fallback;
}

function roleOf(user: StaffUser): string | null {
  const role = user.match?.role;
  return typeof role === "string" ? role : null;
}

/**
 * Impersonation-сессия цели: годная из кэша либо новая. Новая — это
 * запись в прод-аудит 10X, поэтому кэш спрашивается всегда, а причина
 * потребляется только здесь (спека, «email-ветка»).
 */
export async function impersonationToken(
  deps: X10Deps,
  userId: number,
  reason: string,
): Promise<string> {
  const subject = String(userId);
  const cached = readSession(
    deps.db,
    "impersonation",
    subject,
    deps.nowSeconds,
  );
  if (cached !== null) return cached.token;
  const data = await call(deps, {
    method: "POST",
    path: "/auth/impersonate",
    body: { targetUserId: userId, reason },
    token: await staffToken(deps),
  });
  const token = accessToken(data, "10X impersonate");
  remember(deps, "impersonation", subject, token, reason);
  return token;
}

/** Воркспейсы под токеном цели — сырой `data[]` ответа. */
export async function listWorkspaces(
  deps: X10Deps,
  token: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const data = await call(deps, {
    method: "GET",
    path: "/workspaces",
    token,
  });
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is Readonly<Record<string, unknown>> =>
    typeof item === "object" && item !== null && !Array.isArray(item)
  );
}

/**
 * Email клиента из тёплого кэша: строка, среди владений которой есть
 * этот client_id. Дублей быть не должно, но они бывают, и порядок строк
 * SQLite ничего не обещает — побеждает свежайшая `fetched_at`, при
 * равенстве меньшая почта (отклонение `fix` спеки).
 */
export function cachedEmailOfClient(
  db: CacheDb,
  clientId: number,
): string | null {
  const rows = db.query(
    "SELECT email, owned_client_ids FROM x10_email_clients" +
      " ORDER BY fetched_at DESC, email ASC",
  );
  for (const row of rows) {
    if (ownedIds(row).includes(clientId)) return textOf(row.email);
  }
  return null;
}

/** Сессии субъекта для вывода команды: обе, включая протухшие. */
export function sessionsOf(
  db: CacheDb,
  login: string | null,
  userId: number | null,
): readonly Session[] {
  const rows = db.query(
    "SELECT kind, subject, token, reason, created_at, expires_at" +
      " FROM x10_sessions ORDER BY kind",
  );
  const wanted = rows.filter((row) =>
    (textOf(row.kind) === "staff" && textOf(row.subject) === (login ?? "")) ||
    (textOf(row.kind) === "impersonation" &&
      textOf(row.subject) === (userId === null ? "" : String(userId)))
  );
  return wanted.map((row) => ({
    kind: textOf(row.kind) as SessionKind,
    subject: textOf(row.subject),
    token: textOf(row.token),
    reason: typeof row.reason === "string" ? row.reason : null,
    createdAt: intOf(row.created_at),
    expiresAt: intOf(row.expires_at),
  }));
}

/** Отказ 10X с подсказкой про креды у 401/403 (спека, отклонение `fix`). */
export function withCredHint(err: unknown): unknown {
  if (!(err instanceof X10StatusError)) return err;
  if (err.status !== 401 && err.status !== 403) return err;
  return new DomainError(
    `${err.message} (нужны 10X staff-креды X10_LOGIN/X10_PASSWORD,` +
      " не sl-back TOKEN_*)",
    { cause: err },
  );
}

/** Вызов 10X с подсказкой про креды: её текст один на обе ветки. */
async function call(
  deps: X10Deps,
  request: Parameters<typeof x10Call>[1],
): Promise<unknown> {
  try {
    return await x10Call(deps.baseUrl, request, deps.send);
  } catch (err) {
    throw withCredHint(err);
  }
}

/** Кладёт свежую сессию в кэш; срок — из самого токена. */
function remember(
  deps: X10Deps,
  kind: SessionKind,
  subject: string,
  token: string,
  reason: string | null,
): void {
  writeSession(deps.db, {
    kind,
    subject,
    token,
    reason,
    createdAt: deps.nowSeconds,
    expiresAt: expiresAtOf(token, deps.nowSeconds),
  });
}

/** `data.access_token` ответа логина или impersonation. */
function accessToken(data: unknown, where: string): string {
  const token = record(data)?.access_token;
  if (typeof token !== "string" || token === "") {
    throw new DomainError(`${where}: нет access_token в ответе`);
  }
  return token;
}

/** Значение креда или отказ с путём env-файла (спека, «Конфигурация»). */
function requireCred(deps: X10Deps, name: string): string {
  const raw = deps.env.get(name);
  if (raw !== undefined && raw !== "") return raw;
  throw new DomainError(
    `10X credentials missing: ${name}. Add to ${deps.envFilePath}` +
      " or export in shell.",
  );
}

function staffUserOf(raw: unknown, where: string): StaffUser | null {
  const item = record(raw);
  if (item === null) return null;
  const email = item.email;
  if (typeof email !== "string") return null;
  const id = item.id;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new DomainError(`${where}: user.id не число: ${String(id)}`);
  }
  return {
    id,
    email,
    name: typeof item.name === "string" ? item.name : null,
    isEmailVerified: item.isEmailVerified === true,
    match: record(item.match),
  };
}

function isUser(user: StaffUser | null): user is StaffUser {
  return user !== null;
}

function record(raw: unknown): Readonly<Record<string, unknown>> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Readonly<Record<string, unknown>>
    : null;
}

function ownedIds(row: SqlRow): readonly number[] {
  const raw = textOf(row.owned_client_ids);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number")
      : [];
  } catch {
    // Испорченная строка кэша — не отказ команды: она равнозначна
    // отсутствию записи, и ветка уйдёт в сеть.
    return [];
  }
}

function textOf(value: SqlRow[string]): string {
  return typeof value === "string" ? value : "";
}

function intOf(value: SqlRow[string]): number {
  return typeof value === "number" ? value : 0;
}
