/**
 * Общие части группы `mpu api ss-access` (`docs/specs/api-ss-access.md`):
 * авто-тело кнопки, резолв идентификатора выдачи из main-БД и ожидание
 * с пределом.
 *
 * Группа выходит за рамки HTTP: идентификатор выдачи берётся не из
 * ответа сервера, а из `public.spreadsheets_access_grants` — то есть
 * команда знает про схему базы. Отсюда и отдельный класс отказа:
 * упавший резолв и упавший вызов sl-back чинятся по-разному, и
 * различать их оператор должен по сообщению, а не по догадке.
 */

import { UsageError } from "../command/mod.ts";
import type { SqlSession } from "../sql/session.ts";

/**
 * Статусы, входящие в частичный уникальный индекс активной выдачи.
 * Резолв идёт по ним, а не по всем: выдача в `revoked` или `failed`
 * индекс не занимает, и отзывать её незачем — а найденная, она увела бы
 * `reset` в ожидание того, что уже случилось.
 */
export const ACTIVE_STATUSES = [
  "created",
  "permission_added",
  "applied",
] as const;

/** Таблица выдач в main-БД. */
export const GRANTS_TABLE = "public.spreadsheets_access_grants";

/**
 * Колонки, которыми пользуется резолв. Список объявлен отдельно и
 * сверяется с голденом состава
 * (`docs/specs/fixtures/api/schema/spreadsheets_access_grants.columns`),
 * снятым со стенда через `information_schema.columns`: имя колонки —
 * такой же стык, как форма ответа службы, и сочинённое имя не поймает
 * ни один тест с подставной базой. Ключ выдачи зовётся `grant_id`;
 * колонки `id` в таблице нет вовсе (замер 2026-08-28).
 */
export const RESOLVE_COLUMNS = [
  "grant_id",
  "spreadsheet_id",
  "grantee_email",
  "status",
  // Порядок выдачи задаётся временем создания: старшая первой, чтобы
  // отзыв шёл предсказуемо, а не как ляжет.
  "created_at",
] as const;

/** Роль кнопки: сервер другой не принимает. */
export const DEFAULT_ROLE = "editor";

/**
 * Умолчания, снятые с объекта Python-реализации (напарник, 2026-08-28;
 * таблица в спеке). Их три, и они разные — в справке источника стоял
 * сокращённый образец `"reason":"reset"`, который не равен ни одному:
 *
 * - обоснование выдачи (`request`, и `reset` в своей второй половине);
 * - причина отзыва по умолчанию у `revoke`;
 * - причина отзыва внутри `reset` — жёсткий литерал, из `--reason` он
 *   не берётся: `--reason` у `reset` относится к выдаче, а не к отзыву.
 */
export const DEFAULT_REASON = "Диагностика проблемы по обращению клиента";
export const REVOKE_REASON = "revoke via mpu";
export const RESET_REVOKE_REASON = "reset via mpu";

/** Тип job'а отзыва — тот же, что ставит кнопка. */
export const REVOKE_JOB = "accessGrantRevoke";

/** Эндпоинт очереди ss-job'ов; отзыв идёт им, своего у него нет. */
export const JOBS_PATH = "/admin/jobs/ss";

/**
 * Отказ резолва: main-БД недоступна либо ответила не тем. Отдельный
 * класс, потому что у него своя рамка сообщения и свой код выхода —
 * иначе оператор пойдёт чинить sl-back, а сломан доступ к базе
 * (спека, инвариант 4).
 */
export class GrantResolveError extends UsageError {
  override name = "GrantResolveError";
  constructor(reason: string, options?: { cause?: unknown }) {
    super(
      `резолв выдачи в main-БД не удался: ${reason}`,
      { ...options, advice: "проверь доступ к main-БД (pg_0), не к sl-back" },
    );
  }
}

/** Строка выдачи, какой её видит резолв. */
export interface Grant {
  readonly id: string;
  readonly status: string;
}

/**
 * Активные выдачи по паре (таблица, почта владельца токена). Запрос
 * параметризован: идентификатор таблицы и почта приходят от оператора,
 * и склейка их в текст была бы инъекцией в main-БД.
 */
export async function activeGrants(
  session: SqlSession,
  ssId: string,
  email: string,
): Promise<readonly Grant[]> {
  const outcome = await query(
    session,
    // `status` сверх запроса спеки: он идёт в вывод, и брать его
    // вторым запросом незачем. Колонка настоящая — она в голдене.
    `SELECT grant_id, status FROM ${GRANTS_TABLE}` +
      " WHERE spreadsheet_id = $1 AND grantee_email = $2" +
      " AND status = ANY($3) ORDER BY created_at",
    [ssId, email, [...ACTIVE_STATUSES]],
  );
  if (outcome.kind !== "rows") {
    throw new GrantResolveError("выборка не вернула строк-результата");
  }
  const id = outcome.columns.indexOf("grant_id");
  const status = outcome.columns.indexOf("status");
  if (id < 0 || status < 0) {
    throw new GrantResolveError(
      `в выборке нет колонок grant_id/status: ${outcome.columns.join(", ")}`,
    );
  }
  return outcome.rows.map((row) => ({
    id: String(row[id]),
    status: String(row[status]),
  }));
}

/** Запрос к main-БД; любой отказ переводится в отказ резолва. */
async function query(
  session: SqlSession,
  text: string,
  params: readonly unknown[],
) {
  try {
    return await session.query(text, params);
  } catch (err) {
    throw new GrantResolveError(reasonOf(err), { cause: err });
  }
}

/** Тело `request`: умолчания кнопки, поверх них точечные опции. */
export interface RequestOverrides {
  readonly role?: string;
  readonly reason?: string;
  readonly template?: string;
}

/**
 * Авто-тело кнопки sl-front. `--body` сюда не заглядывает: он заменяет
 * тело целиком и отменяет точечные опции, а не смешивается с ними
 * (спека, инвариант 3) — у одного поля не должно быть двух источников.
 */
export function requestBody(
  overrides: RequestOverrides = {},
): Record<string, unknown> {
  return {
    googleSheetsRole: overrides.role ?? DEFAULT_ROLE,
    reason: overrides.reason ?? DEFAULT_REASON,
    // `null`, а не отсутствие ключа: кнопка шлёт поле всегда, и
    // молчаливое его исчезновение меняло бы запрос.
    accessTemplateId: overrides.template ?? null,
  };
}

/** Тело job'а отзыва одной выдачи. */
export function revokeBody(
  grantId: string,
  reason: string,
): Record<string, unknown> {
  return {
    type: REVOKE_JOB,
    data: { grantId, revokedByUserId: null, reason },
  };
}

/** Предел ожидания и шаг опроса у `reset`, в миллисекундах (спека). */
export const WAIT_LIMIT_MS = 60_000;
export const WAIT_STEP_MS = 3_000;

/** Часы и пауза: подменяются в тестах, иначе ожидание не проверить. */
export interface WaitClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Ждёт, пока выдачи уйдут из индекса. Предел обязателен, и его
 * истечение — не успех: молчаливый успех после истечения означал бы,
 * что `reset` выдаёт заново поверх неотозванной выдачи и упирается в
 * тот же уникальный индекс (спека, инвариант 1).
 */
export async function waitGone(
  session: SqlSession,
  ssId: string,
  email: string,
  clock: WaitClock,
  limitMs: number = WAIT_LIMIT_MS,
): Promise<void> {
  const deadline = clock.now() + limitMs;
  for (;;) {
    const left = await activeGrants(session, ssId, email);
    if (left.length === 0) return;
    if (clock.now() >= deadline) {
      throw new WaitTimeoutError(limitMs, left);
    }
    await clock.sleep(WAIT_STEP_MS);
  }
}

/** Предел ожидания исчерпан, а выдача осталась в индексе. */
export class WaitTimeoutError extends Error {
  override name = "WaitTimeoutError";
  constructor(limitMs: number, left: readonly Grant[]) {
    super(
      `выдача осталась в индексе спустя ${Math.round(limitMs / 1000)} с: ` +
        left.map((grant) => `${grant.id} (${grant.status})`).join(", "),
    );
  }
}

export function reasonOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0];
}
