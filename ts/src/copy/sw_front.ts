/**
 * Проводка входа в локальный sw-front (`copy-client.md`, шаг 6):
 * пользователь, workspace и кабинеты клиента в локальной БД
 * воркспейсов.
 *
 * Шаг best-effort: копия схемы и строк к этому моменту уже готова, и
 * ронять из-за проводки нечего — её догоняет повторный запуск.
 *
 * Все записи идемпотентны (`ON CONFLICT … DO UPDATE`): команда
 * рассчитана на повторный прогон поверх прежней копии, а второй
 * пользователь с тем же адресом сделал бы вход неоднозначным.
 */

import type { SqlSession } from "../sql/session.ts";
import { firstColumn, literalOf } from "./rows.ts";

/** Пароль локального входа; он же печатается оператору. */
export const LOCAL_PASSWORD = "123123";

/**
 * Bcrypt-хэш пароля `123123`, cost 10. Значение фиксировано
 * намеренно: хэш считается заново на каждый прогон только затем, чтобы
 * дать тот же вход, а зависимость ради этого не нужна
 * (`copy-client.md`, шаг 6).
 */
const PASSWORD_HASH =
  "$2b$10$cxMCZzMdmIdDRmb18yA2w.JzCc.JPHz8oRp/660kaEDh/xrkSsCnS";

/** Кабинет клиента: идентификатор и имена для витрины. */
export interface Cabinet {
  readonly sid: string;
  readonly name: string;
}

/** Адрес входа: по нему же очистка потом узнаёт свою запись. */
export function localEmail(clientId: number): string {
  return `client_${clientId}@local.host`;
}

/** Кабинеты клиента с локального sl-1 (имена — из схемы клиента). */
export async function cabinetsOf(
  sl1: SqlSession,
  clientId: number,
): Promise<readonly Cabinet[]> {
  const outcome = await sl1.query(
    "SELECT c.sid::text, w.name, w.trade_mark FROM public.clients_wb_cabinets c " +
      `LEFT JOIN schema_${clientId}.wb_cabinets w ON w.sid::text = c.sid::text ` +
      `WHERE c.client_id = ${clientId} ORDER BY c.sid`,
  );
  if (outcome.kind !== "rows") return [];
  return outcome.rows.map((row) => {
    const sid = String(row[0]);
    const name = [row[1], row[2]]
      .map((value) => (value === null ? "" : String(value).trim()))
      .find((value) => value !== "");
    // Пустое имя — обычное дело у свежего кабинета: витрине нужен
    // хоть какой-то заголовок, и номер клиента здесь честнее пустоты.
    return { sid, name: name ?? `client ${clientId}` };
  });
}

/**
 * Операторы проводки: пользователь, workspace, кабинеты и подписки.
 * Собираются одним текстом — одна транзакция, как и посев строк.
 */
export function seedStatements(
  clientId: number,
  cabinets: readonly Cabinet[],
): string {
  const email = literalOf(localEmail(clientId));
  const statements: string[] = [
    `INSERT INTO public.users (email, password, is_email_verified) ` +
    `VALUES (${email}, ${literalOf(PASSWORD_HASH)}, true) ` +
    `ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, ` +
    `is_email_verified = true;`,
    `INSERT INTO public.workspaces (id, owner_id, marketplace, is_active) ` +
    `SELECT ${clientId}, u.id, 'Wildberries', true FROM public.users u ` +
    `WHERE u.email = ${email} ` +
    `ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, ` +
    `is_active = true;`,
  ];
  for (const cabinet of cabinets) {
    const sid = literalOf(cabinet.sid);
    statements.push(
      `INSERT INTO public.wb_cabinets (sid, name, status, marketplace, ` +
        `workspace_id) VALUES (${sid}, ${literalOf(cabinet.name)}, 'ACTIVE', ` +
        `'wildberries', ${clientId}) ON CONFLICT (sid) DO UPDATE SET ` +
        `name = EXCLUDED.name, status = 'ACTIVE';`,
      `INSERT INTO public.workspaces_wb_cabinets (workspace_id, sid) ` +
        `VALUES (${clientId}, ${sid}) ON CONFLICT DO NOTHING;`,
      `INSERT INTO public.subscriptions (sid, is_paid, status, paid_from, ` +
        `paid_to, sku_active_limit, is_active) VALUES (${sid}, true, ` +
        `'ACTIVE', CURRENT_DATE, CURRENT_DATE + 365, 100000, true) ` +
        `ON CONFLICT (sid) DO UPDATE SET is_paid = true, status = 'ACTIVE', ` +
        `paid_to = CURRENT_DATE + 365, is_active = true;`,
    );
  }
  return statements.join("\n");
}

/** Проводка целиком; возвращает число заведённых кабинетов. */
export async function seedLogin(
  sl1: SqlSession,
  workspaces: SqlSession,
  clientId: number,
): Promise<number> {
  const cabinets = await cabinetsOf(sl1, clientId);
  await workspaces.run(seedStatements(clientId, cabinets));
  return cabinets.length;
}

/** Строка клиента для кэша main; её кладёт шаг 5. */
export async function clientCacheJson(
  sl0: SqlSession,
  clientId: number,
): Promise<string | undefined> {
  const outcome = await sl0.query(
    `SELECT row_to_json(c) FROM public.clients c WHERE id = ${clientId}`,
  );
  return firstColumn(outcome)[0];
}
