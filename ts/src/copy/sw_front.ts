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
 *
 * Цели конфликтов сверены на живой схеме воркспейсов стенда
 * 2026-08-28: `users(email)` — уникальный индекс, `users(id)`,
 * `wb_cabinets(sid)` и `subscriptions(sid)` — первичные ключи, а у
 * `workspaces_wb_cabinets` ключ составной, `(workspace_id, sid)`.
 * Знание записано здесь, потому что проверить его из кода нечем:
 * ошибка вылезет только на живой базе, отказом вставки.
 */

import type { SqlSession, Statement } from "../sql/session.ts";
import { firstColumn } from "./rows.ts";

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

/**
 * Заголовок клиента: им зовётся и пользователь, и его workspace, и
 * кабинет без своего имени. Одно место, потому что три расходящихся
 * заголовка у одного клиента — путаница на витрине, а разъезжаются они
 * молча.
 */
export function localTitle(clientId: number): string {
  return `client ${clientId}`;
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
      // Имя схемы — не значение, а часть адреса объекта: параметром
      // его не передать. Оно собрано из числа, которое команда сама и
      // разобрала (`schema_<clientId>`).
      "WHERE c.client_id = $1 ORDER BY c.sid",
    [clientId],
  );
  if (outcome.kind !== "rows") return [];
  return outcome.rows.map((row) => {
    const sid = String(row[0]);
    const name = [row[1], row[2]]
      .map((value) => (value === null ? "" : String(value).trim()))
      .find((value) => value !== "");
    // Пустое имя — обычное дело у свежего кабинета: витрине нужен
    // хоть какой-то заголовок, и номер клиента здесь честнее пустоты.
    return { sid, name: name ?? localTitle(clientId) };
  });
}

/**
 * Операторы проводки: пользователь, workspace, кабинеты и подписки.
 * Уходят одним списком и одной транзакцией, как и посев строк.
 *
 * Значения — параметрами. Прежде они подставлялись в текст, и защитой
 * было удвоение кавычки; работает она, только пока у сервера
 * `standard_conforming_strings = on`, а название кабинета приходит из
 * чужой базы. Настройка сервера — не то, на чём должна держаться
 * правильность запроса.
 *
 * Состав колонок сверен со схемой воркспейсов стенда (замеры
 * 2026-08-28, записаны в `copy-client.md`): у `users` семь
 * NOT NULL-колонок, у `workspaces` нет ни `is_active`, ни
 * `marketplace` — обе прежде перечислялись, и на первой из них падает
 * рабочая версия.
 *
 * Отметки времени проставляются явно, хотя умолчания у них могли и
 * быть: замер снял имена и обязательность, но **не умолчания**, а
 * PostgreSQL называет нарушение NOT NULL по порядку колонок — отказ на
 * `name` (4-я) ничего не говорит про `created_at` (5-я) и `updated_at`
 * (6-ю). `NOW()` там, где сервер и сам подставил бы его, безвреден;
 * его отсутствие там, где умолчания нет, стоило бы ещё одного круга
 * живой пары.
 *
 * Колонки трёх операторов кабинета (`wb_cabinets`,
 * `workspaces_wb_cabinets`, `subscriptions`) замером **не покрыты**: до
 * них исполнение ни разу не доходило — транзакция откатывалась на
 * `users`. Сверены у них только цели конфликтов (докстринг модуля).
 */
export function seedStatements(
  clientId: number,
  cabinets: readonly Cabinet[],
): readonly Statement[] {
  const email = localEmail(clientId);
  const title = localTitle(clientId);
  const statements: Statement[] = [
    {
      sql: "INSERT INTO public.users (email, password, name, " +
        "is_email_verified, created_at, updated_at) " +
        "VALUES ($1, $2, $3, true, NOW(), NOW()) " +
        "ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, " +
        "is_email_verified = true, updated_at = NOW()",
      params: [email, PASSWORD_HASH, title],
      label: "users",
    },
    {
      sql: "INSERT INTO public.workspaces " +
        "(id, owner_id, name, slug, created_at, updated_at) " +
        "SELECT $1::int, u.id, $2, $3, NOW(), NOW() FROM public.users u " +
        "WHERE u.email = $4 " +
        "ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, " +
        "name = EXCLUDED.name, updated_at = NOW()",
      params: [clientId, title, `client-${clientId}`, email],
      label: "workspaces",
    },
  ];
  for (const cabinet of cabinets) {
    statements.push(
      {
        sql: "INSERT INTO public.wb_cabinets (sid, name, status, " +
          "marketplace, workspace_id) VALUES ($1, $2, 'ACTIVE', " +
          "'wildberries', $3) ON CONFLICT (sid) DO UPDATE SET " +
          "name = EXCLUDED.name, status = 'ACTIVE'",
        params: [cabinet.sid, cabinet.name, clientId],
        label: "wb_cabinets",
      },
      // Цель конфликта не названа: первичный ключ здесь составной —
      // `(workspace_id, sid)`, — и `ON CONFLICT (sid)` отбился бы «нет
      // уникального индекса под указанные колонки» (сверено на схеме
      // стенда 2026-08-28). Точная форма `ON CONFLICT (workspace_id,
      // sid)` тоже подошла бы; выбрана безцелевая, потому что связка
      // здесь ровно одна и различать причины конфликта незачем — но
      // молчит она к любому уникальному индексу таблицы, не только к
      // первичному ключу.
      {
        sql: "INSERT INTO public.workspaces_wb_cabinets (workspace_id, sid) " +
          "VALUES ($1, $2) ON CONFLICT DO NOTHING",
        params: [clientId, cabinet.sid],
        label: "workspaces_wb_cabinets",
      },
      {
        sql: "INSERT INTO public.subscriptions (sid, is_paid, status, " +
          "paid_from, paid_to, sku_active_limit, is_active) VALUES " +
          "($1, true, 'ACTIVE', CURRENT_DATE, CURRENT_DATE + 365, " +
          "100000, true) ON CONFLICT (sid) DO UPDATE SET is_paid = true, " +
          "status = 'ACTIVE', paid_to = CURRENT_DATE + 365, is_active = true",
        params: [cabinet.sid],
        label: "subscriptions",
      },
    );
  }
  return statements;
}

/** Проводка целиком; возвращает число заведённых кабинетов. */
export async function seedLogin(
  sl1: SqlSession,
  workspaces: SqlSession,
  clientId: number,
): Promise<number> {
  const cabinets = await cabinetsOf(sl1, clientId);
  await workspaces.runMany(seedStatements(clientId, cabinets));
  return cabinets.length;
}

/** Строка клиента для кэша main; её кладёт шаг 5. */
export async function clientCacheJson(
  sl0: SqlSession,
  clientId: number,
): Promise<string | undefined> {
  const outcome = await sl0.query(
    "SELECT row_to_json(c) FROM public.clients c WHERE id = $1",
    [clientId],
  );
  return firstColumn(outcome)[0];
}
