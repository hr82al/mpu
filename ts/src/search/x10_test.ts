/**
 * Правило выбора кандидата и тёплый email-кэш (`docs/specs/search.md`,
 * «10X-резолв не-email селектора», «email-ветка»): `pickCandidate` —
 * чистая функция над типизированными `StaffUser`, `cachedEmailOfClient`
 * — чтение настоящей кэш-БД во временном каталоге.
 *
 * Значения кандидатов в тестах неоднозначности зеркалят голден
 * `testdata/staff-search-access.json` (id 1001/1002, роли admin/member,
 * ни один не владелец) — тот же случай, что снят каналом.
 */

import { assertEquals } from "@std/assert";
import type { CacheDb } from "../command/mod.ts";
import { openCacheDb } from "../store/mod.ts";
import { cachedEmailOfClient, pickCandidate, type StaffUser } from "./x10.ts";

function user(
  overrides: Partial<StaffUser> & {
    readonly id: number;
    readonly email: string;
  },
): StaffUser {
  return {
    name: null,
    isEmailVerified: false,
    match: null,
    ...overrides,
  };
}

/* --------------------------------------------------------------- *
 * pickCandidate
 * --------------------------------------------------------------- */

Deno.test("pickCandidate: точная почта побеждает, даже если роль не owner", () => {
  const target = user({
    id: 1,
    email: "target@example.com",
    match: { role: "member" },
  });
  const other = user({
    id: 2,
    email: "owner@example.com",
    match: { role: "owner" },
  });
  const result = pickCandidate([other, target], "target@example.com");
  assertEquals(result, { user: target });
});

Deno.test("pickCandidate: точная почта побеждает без учёта регистра", () => {
  const target = user({
    id: 1,
    email: "Target@Example.com",
    match: { role: "member" },
  });
  const result = pickCandidate([target], "target@example.com");
  assertEquals(result, { user: target });
});

Deno.test("pickCandidate: точной нет, ровно один owner — берётся он", () => {
  const owner = user({
    id: 1,
    email: "owner@example.com",
    match: { role: "owner" },
  });
  const member = user({
    id: 2,
    email: "member@example.com",
    match: { role: "member" },
  });
  const result = pickCandidate([member, owner], "запрос-не-почта");
  assertEquals(result, { user: owner });
});

Deno.test("pickCandidate: точной нет, owner'ов нет, двое кандидатов (голден access) — неоднозначность", () => {
  const admin = user({
    id: 1001,
    email: "user@example.com",
    name: "Иван Иванов",
    isEmailVerified: true,
    match: {
      via: "workspace",
      role: "admin",
      workspaceId: 2002,
      workspaceName: "ООО Ромашка",
    },
  });
  const member = user({
    id: 1002,
    email: "second@example.com",
    name: "Пётр Петров",
    isEmailVerified: false,
    match: { via: "workspace", role: "member", workspaceId: 2002 },
  });
  const result = pickCandidate([admin, member], "ООО Ромашка");
  assertEquals(result, { ambiguous: [admin, member] });
});

Deno.test("pickCandidate: точной нет, owner'ов двое — неоднозначность", () => {
  const first = user({
    id: 1,
    email: "a@example.com",
    match: { role: "owner" },
  });
  const second = user({
    id: 2,
    email: "b@example.com",
    match: { role: "owner" },
  });
  const third = user({
    id: 3,
    email: "c@example.com",
    match: { role: "member" },
  });
  const result = pickCandidate([third, first, second], "запрос-не-почта");
  assertEquals(result, { ambiguous: [first, second] });
});

Deno.test("pickCandidate: подстрочное совпадение почты точным не считается", () => {
  // Мутационная точка: `search` не должен impersonate'ить не тот
  // аккаунт из-за подстрочного совпадения почты в staff-поиске.
  const substring = user({
    id: 1,
    email: "not-exact@example.com.evil",
    match: { role: "member" },
  });
  const owner = user({
    id: 2,
    email: "owner@example.com",
    match: { role: "owner" },
  });
  const result = pickCandidate([substring, owner], "exact@example.com");
  assertEquals(result, { user: owner });
});

/* --------------------------------------------------------------- *
 * cachedEmailOfClient: дубль строк email-кэша с одним client_id
 * --------------------------------------------------------------- */

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

function insertEmailRow(
  db: CacheDb,
  row: { email: string; ownedClientIds: readonly number[]; fetchedAt: number },
): void {
  db.execute(
    "INSERT INTO x10_email_clients (email, target_user_id, target_name," +
      " is_email_verified, owned_client_ids, workspaces_json, reason," +
      " fetched_at) VALUES (?, '1', NULL, 0, ?, '[]', 'ТП', ?)",
    row.email,
    JSON.stringify(row.ownedClientIds),
    row.fetchedAt,
  );
}

Deno.test("cachedEmailOfClient: дубль строк, разный fetched_at — побеждает наибольший", async () => {
  await withDb((db) => {
    insertEmailRow(db, {
      email: "old@example.com",
      ownedClientIds: [10],
      fetchedAt: 1_700_000_000,
    });
    insertEmailRow(db, {
      email: "new@example.com",
      ownedClientIds: [10],
      fetchedAt: 1_700_000_500,
    });
    assertEquals(cachedEmailOfClient(db, 10), "new@example.com");
  });
});

Deno.test("cachedEmailOfClient: дубль строк, одинаковый fetched_at — побеждает меньшая лексикографически почта", async () => {
  await withDb((db) => {
    insertEmailRow(db, {
      email: "zzz@example.com",
      ownedClientIds: [10],
      fetchedAt: 1_700_000_000,
    });
    insertEmailRow(db, {
      email: "aaa@example.com",
      ownedClientIds: [10],
      fetchedAt: 1_700_000_000,
    });
    assertEquals(cachedEmailOfClient(db, 10), "aaa@example.com");
  });
});

Deno.test("cachedEmailOfClient: клиента ни у одной строки нет — null", async () => {
  await withDb((db) => {
    insertEmailRow(db, {
      email: "someone@example.com",
      ownedClientIds: [10],
      fetchedAt: 1_700_000_000,
    });
    assertEquals(cachedEmailOfClient(db, 999), null);
  });
});
