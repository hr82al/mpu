/**
 * Ход 10X-ветки `mpu search` (`docs/specs/search.md`): от селектора к
 * цели, от цели к её воркспейсам и строкам клиентов. Вызовы 10X и
 * правило выбора кандидата — в `./x10.ts`; здесь порядок шагов и то, что
 * из них собирается в результат.
 */

import { type CacheDb, DomainError, type SqlRow } from "../command/mod.ts";
import { clientIdsOfSid } from "../selector/cache.ts";
import { effectiveScope, isEmail, type Scope } from "./mode.ts";
import type { SearchRow } from "./row.ts";
import type { Session } from "./session.ts";
import {
  cachedEmailOfClient,
  impersonationToken,
  listWorkspaces,
  pickCandidate,
  sessionsOf,
  staffSearch,
  staffToken,
  type StaffUser,
  type X10Deps,
} from "./x10.ts";

/** Воркспейс цели в выводе команды: только то, что печатается. */
export interface MemberWorkspace {
  readonly workspace_id: number | null;
  readonly name: string | null;
  readonly marketplace: string | null;
}

/** Данные о цели, попадающие в вывод (спека, «Ввод/вывод»). */
export interface X10Target {
  readonly email: string;
  readonly target_user_id: string;
  readonly target_name: string | null;
  readonly is_email_verified: boolean;
  readonly reason: string;
  readonly fetched_at: number;
  readonly owned_client_ids: readonly number[];
  readonly member_only: readonly MemberWorkspace[];
  readonly workspaces: readonly Readonly<Record<string, unknown>>[];
}

/** Итог ветки: цель либо неоднозначность (сессию она не создаёт). */
export type X10Outcome =
  | { readonly kind: "target"; readonly target: X10Target }
  | { readonly kind: "ambiguous"; readonly candidates: readonly StaffUser[] };

/** Что ветке нужно от вызова. */
export interface X10Query {
  readonly value: string;
  readonly scope: Scope;
  readonly reason: string;
  readonly refreshCache: boolean;
}

/**
 * Цель вызова. Порядок ступеней — спека: тёплый кэш, потом staff-поиск,
 * потом impersonation. Кэш спрашивается всегда, кроме `--refresh-cache`:
 * impersonate пишет прод-аудит, и лишней записи там быть не должно.
 */
export async function resolveX10(
  deps: X10Deps,
  query: X10Query,
): Promise<X10Outcome> {
  const email = isEmail(query.value) ? query.value.toLowerCase() : null;
  if (email !== null) return await byEmail(deps, query, email);
  return await bySelector(deps, query);
}

/** Email-ветка: тёплая строка кэша либо полный резолв через 10X. */
async function byEmail(
  deps: X10Deps,
  query: X10Query,
  email: string,
): Promise<X10Outcome> {
  if (!query.refreshCache) {
    const cached = cachedTarget(deps.db, email);
    if (cached !== null) return { kind: "target", target: cached };
  }
  const token = await staffToken(deps);
  const users = await staffSearch(deps, token, email);
  const exact = users.filter(
    (user) => user.email.toLowerCase() === email,
  );
  if (exact.length === 0) {
    throw new DomainError(
      `10X staff search: нет пользователя с точным email '${email}'` +
        ` (по substring найдено ${users.length}); проверь адрес или что` +
        " это не staff-аккаунт",
    );
  }
  if (exact.length > 1) {
    throw new DomainError(
      `10X staff search: несколько юзеров с email '${email}': ids=[` +
        `${exact.map((user) => user.id).join(", ")}]`,
    );
  }
  return { kind: "target", target: await target(deps, exact[0], query.reason) };
}

/**
 * 10X-резолв не-email селектора. Тёплый кэш работает только для
 * `access`: там селектор — client_id или кабинет, то есть его можно
 * сопоставить со строкой email-кэша, не спрашивая 10X.
 */
async function bySelector(
  deps: X10Deps,
  query: X10Query,
): Promise<X10Outcome> {
  const scope = effectiveScope(query.value, query.scope);
  if (scope === "access" && !query.refreshCache) {
    const clientId = clientIdOfSelector(deps.db, query.value);
    const email = clientId === null
      ? null
      : cachedEmailOfClient(deps.db, clientId);
    if (email !== null) {
      const cached = cachedTarget(deps.db, email);
      if (cached !== null) return { kind: "target", target: cached };
    }
  }
  const token = await staffToken(deps);
  const users = await staffSearch(deps, token, query.value, scope);
  if (users.length === 0) {
    throw new DomainError(
      `10X staff search (scope=${scope}): по '${query.value}' никого не` +
        " найдено; названием клиента/кабинета не ищется — используй" +
        " client_id, sid, email или имя",
    );
  }
  const picked = pickCandidate(users, query.value);
  if ("ambiguous" in picked) {
    return { kind: "ambiguous", candidates: picked.ambiguous };
  }
  return {
    kind: "target",
    target: await target(deps, picked.user, query.reason),
  };
}

/**
 * Impersonation и воркспейсы цели: последние две ступени, общие обеим
 * веткам. Результат кладётся в кэш — следующий вызов сети не потребует.
 */
async function target(
  deps: X10Deps,
  user: StaffUser,
  reason: string,
): Promise<X10Target> {
  const token = await impersonationToken(deps, user.id, reason);
  const workspaces = await listWorkspaces(deps, token);
  const owned: number[] = [];
  const memberOnly: MemberWorkspace[] = [];
  for (const workspace of workspaces) {
    const id = numberOf(workspace.id);
    if (numberOf(workspace.ownerId) === user.id) {
      if (id !== null) owned.push(id);
      continue;
    }
    memberOnly.push({
      workspace_id: id,
      name: stringOf(workspace.name),
      marketplace: stringOf(workspace.marketplace),
    });
  }
  const found: X10Target = {
    email: user.email.toLowerCase(),
    target_user_id: String(user.id),
    target_name: user.name,
    is_email_verified: user.isEmailVerified,
    reason,
    fetched_at: deps.nowSeconds,
    owned_client_ids: owned,
    member_only: memberOnly,
    workspaces,
  };
  writeTarget(deps.db, found);
  return found;
}

/** Тёплая строка email-кэша как цель; строки нет — `null`. */
function cachedTarget(db: CacheDb, email: string): X10Target | null {
  const rows = db.query(
    "SELECT email, target_user_id, target_name, is_email_verified," +
      " owned_client_ids, workspaces_json, reason, fetched_at" +
      " FROM x10_email_clients WHERE email = ?",
    email,
  );
  const row = rows[0];
  if (row === undefined) return null;
  const workspaces = parseWorkspaces(row.workspaces_json);
  const owned = parseOwned(row.owned_client_ids);
  const userId = Number(textOf(row.target_user_id));
  return {
    email: textOf(row.email),
    target_user_id: textOf(row.target_user_id),
    target_name: typeof row.target_name === "string" ? row.target_name : null,
    is_email_verified: intOf(row.is_email_verified) === 1,
    reason: textOf(row.reason),
    fetched_at: intOf(row.fetched_at),
    owned_client_ids: owned,
    // Владение считается по `ownerId`, а не по списку owned: правило
    // одно и то же на свежем ответе и на строке кэша.
    member_only: workspaces
      .filter((workspace) => numberOf(workspace.ownerId) !== userId)
      .map((workspace) => ({
        workspace_id: numberOf(workspace.id),
        name: stringOf(workspace.name),
        marketplace: stringOf(workspace.marketplace),
      })),
    workspaces,
  };
}

/** Кладёт цель в email-кэш вместо прежней строки. */
function writeTarget(db: CacheDb, target: X10Target): void {
  db.execute(
    "INSERT INTO x10_email_clients (email, target_user_id, target_name," +
      " is_email_verified, owned_client_ids, workspaces_json, reason," +
      " fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT(email) DO UPDATE SET target_user_id =" +
      " excluded.target_user_id, target_name = excluded.target_name," +
      " is_email_verified = excluded.is_email_verified, owned_client_ids =" +
      " excluded.owned_client_ids, workspaces_json = excluded.workspaces_json," +
      " reason = excluded.reason, fetched_at = excluded.fetched_at",
    target.email,
    target.target_user_id,
    target.target_name,
    target.is_email_verified ? 1 : 0,
    JSON.stringify(target.owned_client_ids),
    JSON.stringify(target.workspaces),
    target.reason,
    target.fetched_at,
  );
}

/**
 * client_id селектора для тёплого кэша: целое — оно само, кабинет —
 * единственный клиент кэша sid'ов; иначе `null` (кэш не поможет).
 */
function clientIdOfSelector(db: CacheDb, value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const found = clientIdsOfSid(db, value);
  return found.length === 1 ? found[0] : null;
}

/** Сессии цели для вывода; протухшие тоже печатаются, с `valid: false`. */
export function targetSessions(
  db: CacheDb,
  login: string | null,
  userId: number | null,
  nowSeconds: number,
): readonly (Session & { readonly valid: boolean })[] {
  return sessionsOf(db, login, userId).map((session) => ({
    ...session,
    valid: session.expiresAt > nowSeconds,
  }));
}

/** Строка результата клиента, которого нет в снапшоте (спека). */
export function bareRow(clientId: number): SearchRow {
  return {
    client_id: clientId,
    spreadsheet_id: null,
    title: null,
    server: null,
    server_number: null,
    sl_ip: null,
    pg_ip: null,
    sids: [],
  };
}

function parseWorkspaces(
  raw: SqlRow[string],
): readonly Readonly<Record<string, unknown>>[] {
  try {
    const parsed = JSON.parse(textOf(raw));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Readonly<Record<string, unknown>> =>
        typeof item === "object" && item !== null && !Array.isArray(item)
      )
      : [];
  } catch {
    return [];
  }
}

function parseOwned(raw: SqlRow[string]): readonly number[] {
  try {
    const parsed = JSON.parse(textOf(raw));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number")
      : [];
  } catch {
    return [];
  }
}

function numberOf(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function stringOf(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

function textOf(value: SqlRow[string]): string {
  return typeof value === "string" ? value : "";
}

function intOf(value: SqlRow[string]): number {
  return typeof value === "number" ? value : 0;
}
