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

/**
 * Начало оператора, снимающего чужую привязку кабинета. По нему вызов
 * узнаёт, сколько связок снято: молча удалять чужую строку нельзя, а
 * число известно только серверу.
 *
 * Узнаётся по тексту, а не по метке: метка идёт оператору в текст
 * отказа (`Statement.label`), и внутреннему признаку там не место —
 * человек ждёт имя таблицы, а не наш селектор.
 */
export const DETACH_SQL = "DELETE FROM public.workspaces_wb_cabinets";

/** Кабинет клиента: идентификатор и оба обязательных имени витрины. */
export interface Cabinet {
  readonly sid: string;
  readonly name: string;
  /** Торговая марка; в схеме воркспейсов она NOT NULL без умолчания. */
  readonly trade_mark: string;
}

/**
 * Запасное имя кабинета: им зовётся кабинет без собственного имени и
 * без торговой марки. Форм у заголовка клиента три и они разные —
 * `client_<id>` у пользователя, `client-<id>` у воркспейса,
 * `client <id>` здесь (`copy-client.md`, шаг 6); сводить их в одну
 * нельзя, а держать три литерала врассыпную — значит развести их при
 * первой же правке.
 */
export function cabinetFallback(clientId: number): string {
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
    const text = (value: unknown) =>
      value === null || value === undefined ? "" : String(value).trim();
    const name = text(row[1]);
    const trade = text(row[2]);
    // Пустое имя — обычное дело у свежего кабинета, а обе колонки на
    // приёмнике обязательны: витрине нужен хоть какой-то заголовок, и
    // номер клиента здесь честнее пустоты. Имя вдобавок подхватывает
    // торговую марку — заголовок из неё осмысленнее номера.
    return {
      sid,
      name: name !== ""
        ? name
        : trade !== ""
        ? trade
        : cabinetFallback(clientId),
      trade_mark: trade !== "" ? trade : cabinetFallback(clientId),
    };
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
 * Состав колонок отвечает форме всех пяти таблиц, снятой со стенда и
 * записанной в `copy-client.md` («Известные ловушки окружения»).
 * Оттуда же три вещи, которых не дал бы замер одной таблицы:
 * `updated_at` объявлена NOT NULL **без умолчания** везде, где есть
 * (`users`, `workspaces`, `subscriptions`), а у `wb_cabinets` её нет
 * вовсе; `workspaces.slug` обязателен и уникален; у `subscriptions`
 * нет `workspace_id` — подписка привязана к кабинету, не к
 * пространству. Колонки `is_active` у `workspaces` нет — на ней падает
 * рабочая версия; `marketplace` есть и допускает NULL.
 *
 * Значения перечислений приводятся к типу явно: параметр приходит
 * текстом, и вывести тип серверу неоткуда. Имя типа квалифицировано
 * схемой по той же причине, по которой значения ушли параметрами —
 * правильность запроса не должна зависеть от настройки (там от
 * `standard_conforming_strings`, здесь от `search_path` роли).
 */
export function seedStatements(
  clientId: number,
  cabinets: readonly Cabinet[],
): readonly Statement[] {
  const email = localEmail(clientId);
  const statements: Statement[] = [
    {
      sql: "INSERT INTO public.users (email, password, name, " +
        "is_email_verified, created_at, updated_at) " +
        "VALUES ($1, $2, $3, true, NOW(), NOW()) " +
        "ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, " +
        "name = EXCLUDED.name, is_email_verified = true, updated_at = NOW()",
      params: [email, PASSWORD_HASH, `client_${clientId}`],
      label: "users",
    },
    {
      sql: "INSERT INTO public.workspaces " +
        "(id, owner_id, name, slug, marketplace, created_at, updated_at) " +
        "SELECT $1::int, u.id, $2, $3, 'Wildberries', NOW(), NOW() " +
        "FROM public.users u WHERE u.email = $4 " +
        // `slug` уникален и в обновление не входит: повторный прогон не
        // должен переписывать чужой slug своим (`copy-client.md`).
        "ON CONFLICT (id) DO UPDATE SET owner_id = EXCLUDED.owner_id, " +
        "name = EXCLUDED.name, marketplace = EXCLUDED.marketplace, " +
        "updated_at = NOW()",
      params: [clientId, `client-${clientId}`, `client-${clientId}`, email],
      label: "workspaces",
    },
  ];
  for (const cabinet of cabinets) {
    statements.push(
      {
        // `trade_mark` обязательна и умолчания не имеет — под то же
        // правило подстановки, что и пустое имя. Колонки `updated_at`
        // у этой таблицы нет вовсе.
        sql: "INSERT INTO public.wb_cabinets " +
          "(sid, name, trade_mark, status, marketplace, workspace_id) " +
          "VALUES ($1, $2, $3, $4::\"WbTokenStatus\", 'wildberries', $5) " +
          "ON CONFLICT (sid) DO UPDATE SET name = EXCLUDED.name, " +
          "trade_mark = EXCLUDED.trade_mark, " +
          // Кабинет мог быть перевешен на другого клиента: без этого
          // он остался бы привязан к прежнему воркспейсу, а связка в
          // `workspaces_wb_cabinets` (DO NOTHING) добавилась бы второй.
          "workspace_id = EXCLUDED.workspace_id, " +
          "marketplace = EXCLUDED.marketplace, " +
          'status = $4::public."WbTokenStatus"',
        params: [
          cabinet.sid,
          cabinet.name,
          cabinet.trade_mark,
          "ACTIVE",
          clientId,
        ],
        label: "wb_cabinets",
      },
      // Связка переезжает вместе с кабинетом. Строку `wb_cabinets` мы
      // только что перевесили на этот воркспейс; связка, оставшаяся у
      // прежнего, утверждала бы о том же sid обратное — кабинет
      // оказался бы в двух пространствах сразу (замер 2026-08-28: пять
      // связок при четырёх кабинетах).
      //
      // Удаление **до** вставки и с условием «чужой воркспейс»: свою
      // связку сносить нечем, а прогон, повторённый подряд, не должен
      // ни задваивать, ни сообщать о снятии того, чего уже нет.

      {
        sql: "DELETE FROM public.workspaces_wb_cabinets " +
          "WHERE sid = $1 AND workspace_id <> $2",
        params: [cabinet.sid, clientId],
        label: "workspaces_wb_cabinets",
      },
      // Цель конфликта не названа: первичный ключ здесь составной —
      // `(workspace_id, sid)`, — и `ON CONFLICT (sid)` отбился бы «нет
      // уникального индекса под указанные колонки». Точная форма
      // `ON CONFLICT (workspace_id, sid)` тоже подошла бы; выбрана
      // безцелевая, потому что связка здесь ровно одна и различать
      // причины конфликта незачем — но молчит она к любому уникальному
      // индексу таблицы, не только к первичному ключу.
      {
        sql: "INSERT INTO public.workspaces_wb_cabinets (workspace_id, sid) " +
          "VALUES ($1, $2) ON CONFLICT DO NOTHING",
        params: [clientId, cabinet.sid],
        label: "workspaces_wb_cabinets",
      },
      {
        // Подписка привязана к кабинету, а не к пространству: ключ
        // `sid`, он же внешний ключ на `wb_cabinets`, а колонки
        // `workspace_id` в таблице нет вовсе.
        sql: "INSERT INTO public.subscriptions (sid, is_paid, status, " +
          "paid_from, paid_to, sku_active_limit, is_active, updated_at) " +
          'VALUES ($1, true, $2::public."SubscriptionStatus", CURRENT_DATE, ' +
          "CURRENT_DATE + 365, 100000, true, NOW()) " +
          "ON CONFLICT (sid) DO UPDATE SET is_paid = true, " +
          'status = $2::public."SubscriptionStatus", ' +
          "paid_to = CURRENT_DATE + 365, is_active = true, updated_at = NOW()",
        params: [cabinet.sid, "ACTIVE"],
        label: "subscriptions",
      },
    );
  }
  return statements;
}

/** Итог проводки: сколько кабинетов заведено и сколько чужих связок снято. */
export interface SeedOutcome {
  readonly cabinets: number;
  /** Связки, снятые с чужих воркспейсов; 0 — снимать было нечего. */
  readonly detached: number;
}

/** Проводка целиком. */
export async function seedLogin(
  sl1: SqlSession,
  workspaces: SqlSession,
  clientId: number,
): Promise<SeedOutcome> {
  const cabinets = await cabinetsOf(sl1, clientId);
  const statements = seedStatements(clientId, cabinets);
  const outcomes = await workspaces.runMany(statements);
  // Число снятых привязок известно только серверу: он один знает,
  // нашлась ли чужая строка. Считаем по тем операторам, что её снимали.
  const detached = statements.reduce((sum, statement, at) => {
    if (!statement.sql.startsWith(DETACH_SQL)) return sum;
    const outcome = outcomes[at];
    return sum + (outcome?.kind === "done" ? Math.max(0, outcome.rowcount) : 0);
  }, 0);
  return { cabinets: cabinets.length, detached };
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
