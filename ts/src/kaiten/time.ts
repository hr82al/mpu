/**
 * Каталог учёта времени и таймеров Kaiten
 * (`docs/specs/platform/kaiten-api-time.md`): девять вызовов внешнего
 * API — записи времени карточки, записи пользователя за окно, жизненный
 * цикл личного таймера и справочник ролей.
 *
 * Слой — порт к внешней системе: форма запроса и разбор ответа, ничего
 * больше. Рендер, локальное хранилище и командная логика (парсер
 * длительностей, московские даты, выбор роли по названию) сюда не
 * входят — это дело командных спек. Полнота порта — требование спеки
 * («Назначение»), поэтому объявлены все девять вызовов, включая те, у
 * которых в этой волне команд ещё нет вызывающего кода.
 *
 * Транспорт (доступ, retry, формат ошибки) — `./http.ts`.
 */

import {
  booleanOrNull,
  isRecord,
  type KaitenAccess,
  kaitenCall,
  kaitenCallArray,
  type KaitenCallOptions,
  KaitenError,
  type KaitenRequest,
  numberOrNull,
  stringOr,
  stringOrNull,
} from "./http.ts";

/** Роль компании — «тип работ» записи времени (вызов 9). */
export interface KaitenRole {
  readonly id: number;
  readonly name: string;
}

/**
 * Запись учёта времени (вызов 1 и форма ответа вызовов 2, 3, 5).
 * `timeSpent` — целые минуты; `forDate` — календарный день `YYYY-MM-DD`
 * (в ответах на POST и PATCH сервер шлёт полную ISO-метку, но значим
 * только день, поэтому форма несёт именно день).
 */
export interface TimeLog {
  readonly id: number;
  readonly cardId: number;
  readonly userId: number | null;
  readonly authorId: number | null;
  readonly roleId: number | null;
  readonly roleName: string | null;
  readonly userName: string | null;
  readonly timeSpent: number;
  readonly forDate: string;
  readonly comment: string;
}

/**
 * Карточка записи пользователя (вызов 5). В ответе все её поля
 * необязательны, поэтому в форме порта каждое — «значение или `null`»:
 * отсутствующее поле и присланный `null` для потребителя одно и то же.
 */
export interface TimeLogCard {
  readonly id: number | null;
  readonly title: string | null;
  readonly state: number | null;
  readonly condition: number | null;
  readonly dueDate: string | null;
  readonly updated: string | null;
  readonly boardId: number | null;
  readonly columnId: number | null;
  readonly laneId: number | null;
  readonly archived: boolean | null;
  readonly lastMovedAt: string | null;
  /** Сумма минут по карточке ВСЕМИ участниками, не только этим пользователем. */
  readonly timeSpentSum: number | null;
  readonly boardTitle: string | null;
  readonly spaceTitle: string | null;
  readonly columnTitle: string | null;
  readonly laneTitle: string | null;
  readonly typeName: string | null;
}

/** Запись пользователя за окно: форма вызова 1 плюс карточка записи. */
export type UserTimeLog = TimeLog & {
  readonly card: TimeLogCard | null;
};

/**
 * Личный таймер пользователя: ответ вызовов 6 и 7 и он же — таймер,
 * вложенный в полную карточку (`./cards.ts`). Форма одна: спека свела её в
 * одно место (`kaiten-api-time.md`, вызов 6).
 */
export interface Timer {
  readonly id: number;
  readonly cardId: number | null;
  readonly cardTitle: string;
  readonly comment: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Запись времени, созданная остановкой (вызов 7); у идущего таймера — `null`. */
  readonly cardTimeLogId: number | null;
}

/** Создаваемая запись времени (вызов 2): все четыре поля обязательны. */
export interface TimeLogEntry {
  readonly forDate: string;
  readonly timeSpent: number;
  readonly roleId: number;
  /** Пустая строка — запись без комментария. */
  readonly comment: string;
}

/**
 * Изменяемые поля записи (вызов 3): задаются только меняющиеся,
 * остальные сервер не трогает. Пустая строка в `comment` — не «поле не
 * задано», а команда очистить комментарий.
 */
export interface TimeLogPatch {
  readonly forDate?: string;
  readonly timeSpent?: number;
  readonly roleId?: number;
  readonly comment?: string;
}

/**
 * Окно записей пользователя (вызов 5): обе границы обязательны и уходят
 * всегда — без них сервер отвечает 500, а не «за всё время».
 */
export interface TimeLogWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * Запуск таймера (вызов 6). Роли здесь нет намеренно: API принимает
 * `role_id`, но не сохраняет его — тип работы выбирается только при
 * остановке (`TimerStopRequest`).
 */
export interface TimerStartRequest {
  readonly cardId: number;
  /** Не задан — ключа `comment` в теле нет вовсе. */
  readonly comment?: string;
}

/** Остановка таймера (вызов 7): метка конца обязательна. */
export interface TimerStopRequest {
  readonly finishedAt: string;
  /** Переопределяет фактическое время старта. */
  readonly startedAt?: string;
  readonly comment?: string;
  /** Здесь роль впервые применяется и сохраняется. */
  readonly roleId?: number;
}

/**
 * Итог запуска таймера: успех либо конфликт — у пользователя уже идёт
 * таймер (один на всю компанию, не по одному на карточку). Конфликт
 * узнаётся по СОСТАВУ ТЕЛА, а не по коду: нормальный путь — статус 400,
 * но разбор по отсутствию `id` остаётся и для 2xx с телом-конфликтом
 * (`kaiten-api-time.md`, вызов 6). Карточки в ответе нет — назвать её
 * может только отдельное чтение, и это дело вызывающего.
 */
export type TimerStartOutcome =
  | { readonly kind: "started"; readonly timer: Timer }
  | { readonly kind: "conflict"; readonly message: string };

/** 1. Записи учёта времени карточки — всех её пользователей, не только текущего. */
export async function listCardTimeLogs(
  access: KaitenAccess,
  cardId: number,
  options: KaitenCallOptions = {},
): Promise<readonly TimeLog[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: `/cards/${cardId}/time-logs`,
  }, options);
  return collectTimeLogs(raw);
}

/** 2. Создать запись времени: все четыре поля тела обязательны. */
export async function createCardTimeLog(
  access: KaitenAccess,
  cardId: number,
  entry: TimeLogEntry,
  options: KaitenCallOptions = {},
): Promise<TimeLog> {
  const request: KaitenRequest = {
    method: "POST",
    path: `/cards/${cardId}/time-logs`,
    body: {
      for_date: entry.forDate,
      time_spent: entry.timeSpent,
      role_id: entry.roleId,
      comment: entry.comment,
    },
  };
  return requireTimeLog(request, await kaitenCall(access, request, options));
}

/**
 * 3. Частичное обновление записи: в теле только заданные поля. Ответ —
 * запись целиком, включая не изменившиеся поля.
 */
export async function updateCardTimeLog(
  access: KaitenAccess,
  cardId: number,
  logId: number,
  patch: TimeLogPatch,
  options: KaitenCallOptions = {},
): Promise<TimeLog> {
  const body: Record<string, unknown> = {};
  if (patch.forDate !== undefined) body.for_date = patch.forDate;
  if (patch.timeSpent !== undefined) body.time_spent = patch.timeSpent;
  if (patch.roleId !== undefined) body.role_id = patch.roleId;
  // Проверка на `undefined`, а не на пустоту: пустая строка — значимое
  // значение, она очищает комментарий (сервер нормализует её в `null`,
  // последующее чтение снова отдаёт `""`).
  if (patch.comment !== undefined) body.comment = patch.comment;

  const request: KaitenRequest = {
    method: "PATCH",
    path: `/cards/${cardId}/time-logs/${logId}`,
    body,
  };
  return requireTimeLog(request, await kaitenCall(access, request, options));
}

/** 4. Удалить запись времени; успех — 2xx с пустым телом. */
export async function deleteCardTimeLog(
  access: KaitenAccess,
  cardId: number,
  logId: number,
  options: KaitenCallOptions = {},
): Promise<void> {
  await kaitenCall(access, {
    method: "DELETE",
    path: `/cards/${cardId}/time-logs/${logId}`,
  }, options);
}

/**
 * 5. Записи пользователя за окно по всем карточкам, где он списывал
 * время. Обе границы окна уходят всегда — без них сервер отвечает 500.
 */
export async function listUserTimeLogs(
  access: KaitenAccess,
  userId: number,
  window: TimeLogWindow,
  options: KaitenCallOptions = {},
): Promise<readonly UserTimeLog[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: `/users/${userId}/time-logs`,
    query: { from: window.from, to: window.to },
  }, options);
  const logs: UserTimeLog[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const log = parseTimeLog(item);
    if (log === null) continue;
    logs.push({ ...log, card: parseTimeLogCard(item.card) });
  }
  return logs;
}

/**
 * 6. Запустить личный таймер на карточке. Запрос ровно один: конфликт
 * узнаётся из ответа, а не предугадывается чтением до него. Форму
 * различает НАЛИЧИЕ `id` в теле, а не HTTP-статус — и в успешном ответе,
 * и в теле отказа не-2xx.
 */
export async function startUserTimer(
  access: KaitenAccess,
  start: TimerStartRequest,
  options: KaitenCallOptions = {},
): Promise<TimerStartOutcome> {
  const body: Record<string, unknown> = { card_id: start.cardId };
  if (start.comment !== undefined) body.comment = start.comment;

  let raw: unknown;
  try {
    raw = await kaitenCall(access, {
      method: "POST",
      path: "/user-timers",
      body,
    }, options);
  } catch (err) {
    const conflict = conflictInFailure(err);
    // Отказ не той формы — не наше дело: он уходит вызывающему как есть.
    if (conflict === null) throw err;
    return conflict;
  }

  const timer = parseTimer(raw);
  return timer === null
    ? { kind: "conflict", message: conflictMessage(raw) }
    : { kind: "started", timer };
}

/**
 * 7. Остановить таймер: сервер создаёт запись учёта времени и сам
 * округляет её длительность (`finished_at − started_at`) вверх до целой
 * минуты — порт длительность не считает и в теле не передаёт.
 */
export async function stopUserTimer(
  access: KaitenAccess,
  timerId: number,
  stop: TimerStopRequest,
  options: KaitenCallOptions = {},
): Promise<Timer> {
  const body: Record<string, unknown> = { finished_at: stop.finishedAt };
  if (stop.startedAt !== undefined) body.started_at = stop.startedAt;
  if (stop.comment !== undefined) body.comment = stop.comment;
  if (stop.roleId !== undefined) body.role_id = stop.roleId;

  const request: KaitenRequest = {
    method: "PATCH",
    path: `/user-timers/${timerId}`,
    body,
  };
  return requireTimer(request, await kaitenCall(access, request, options));
}

/** 8. Сбросить таймер БЕЗ создания записи времени — в отличие от вызова 7. */
export async function resetUserTimer(
  access: KaitenAccess,
  timerId: number,
  options: KaitenCallOptions = {},
): Promise<void> {
  await kaitenCall(access, {
    method: "DELETE",
    path: `/user-timers/${timerId}`,
  }, options);
}

/** 9. Роли компании — «типы работ», используемые как `role_id`. */
export async function listUserRoles(
  access: KaitenAccess,
  options: KaitenCallOptions = {},
): Promise<readonly KaitenRole[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: "/user-roles",
  }, options);
  const roles: KaitenRole[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = numberOrNull(item.id);
    if (id === null) continue;
    roles.push({ id, name: stringOr(item.name, "") });
  }
  return roles;
}

/** Элементы без числового `id` записью времени не являются и пропускаются. */
function collectTimeLogs(raw: readonly unknown[]): readonly TimeLog[] {
  const logs: TimeLog[] = [];
  for (const item of raw) {
    const log = parseTimeLog(item);
    if (log !== null) logs.push(log);
  }
  return logs;
}

/**
 * Разбор записи времени; `null` — тело не запись. Записью не считается
 * тело без числовых `id` и `card_id`: спека объявляет оба числами (в
 * отличие от соседних `user_id`/`author_id`, где `null` — штатное
 * значение).
 */
function parseTimeLog(raw: unknown): TimeLog | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  const cardId = numberOrNull(raw.card_id);
  if (id === null || cardId === null) return null;
  return {
    id,
    cardId,
    userId: numberOrNull(raw.user_id),
    authorId: numberOrNull(raw.author_id),
    roleId: numberOrNull(raw.role_id),
    roleName: nestedName(raw.role),
    userName: userDisplayName(raw.user),
    timeSpent: numberOrNull(raw.time_spent) ?? 0,
    forDate: calendarDay(stringOr(raw.for_date, "")),
    comment: stringOr(raw.comment, ""),
  };
}

/**
 * Разбор таймера; `null` — тело не таймер. Таймером тело делает ТОЛЬКО
 * числовой `id`: прочие поля в различении форм ответа запуска (вызов 6) не
 * участвуют, и ответ с пустым `card_id` — таймер, а не конфликт.
 *
 * Экспортируется мимо `mod.ts` соседнему каталогу карточек: таймер,
 * вложенный в полную карточку, — та же форма, и второй её разбор
 * разошёлся бы с этим.
 */
export function parseTimer(raw: unknown): Timer | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    cardId: numberOrNull(raw.card_id),
    cardTitle: stringOr(raw.card_title, ""),
    comment: stringOr(raw.comment, ""),
    startedAt: stringOrNull(raw.started_at),
    finishedAt: stringOrNull(raw.finished_at),
    cardTimeLogId: numberOrNull(raw.card_time_log_id),
  };
}

/** Карточка записи пользователя; `null` — карточки в ответе нет. */
function parseTimeLogCard(raw: unknown): TimeLogCard | null {
  if (!isRecord(raw)) return null;
  return {
    id: numberOrNull(raw.id),
    title: stringOrNull(raw.title),
    state: numberOrNull(raw.state),
    condition: numberOrNull(raw.condition),
    dueDate: stringOrNull(raw.due_date),
    updated: stringOrNull(raw.updated),
    boardId: numberOrNull(raw.board_id),
    columnId: numberOrNull(raw.column_id),
    laneId: numberOrNull(raw.lane_id),
    archived: booleanOrNull(raw.archived),
    lastMovedAt: stringOrNull(raw.last_moved_at),
    timeSpentSum: numberOrNull(raw.time_spent_sum),
    boardTitle: stringOrNull(raw.board_title),
    spaceTitle: stringOrNull(raw.space_title),
    columnTitle: stringOrNull(raw.column_title),
    laneTitle: stringOrNull(raw.lane_title),
    typeName: stringOrNull(raw.type_name),
  };
}

/** Ответ на одиночный вызов обязан быть записью времени. */
function requireTimeLog(request: KaitenRequest, raw: unknown): TimeLog {
  const log = parseTimeLog(raw);
  if (log === null) {
    throw new KaitenError(
      `kaiten ${request.method} ${request.path}: ответ не запись времени`,
    );
  }
  return log;
}

/** Ответ на остановку обязан быть таймером (у запуска есть вторая форма). */
function requireTimer(request: KaitenRequest, raw: unknown): Timer {
  const timer = parseTimer(raw);
  if (timer === null) {
    throw new KaitenError(
      `kaiten ${request.method} ${request.path}: ответ не таймер`,
    );
  }
  return timer;
}

/** Текст конфликтной формы запуска — как прислал сервер, без своего. */
function conflictMessage(raw: unknown): string {
  return isRecord(raw) ? stringOr(raw.message, "") : "";
}

/**
 * Конфликт таймера в отказе не-2xx; `null` — отказ не конфликтный и
 * принадлежит вызывающему. Признак — тот же, что у формы успеха:
 * объект-тело БЕЗ `id`, но со своим `message`. Требование `message`
 * отделяет конфликт от прочих отказов эндпоинта, у которых тела либо
 * нет, либо оно не JSON.
 */
function conflictInFailure(err: unknown): TimerStartOutcome | null {
  if (!(err instanceof KaitenError) || err.body === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.body);
  } catch {
    // Тело не JSON — значит и не форма конфликта; своего разбора у
    // отказа нет, он уходит вызывающему нетронутым.
    return null;
  }
  if (!isRecord(parsed) || parsed.id !== undefined) return null;
  const message = stringOrNull(parsed.message);
  return message === null ? null : { kind: "conflict", message };
}

/** Название вложенного объекта-справочника (`role`): значимо только `name`. */
function nestedName(raw: unknown): string | null {
  return isRecord(raw) ? stringOrNull(raw.name) : null;
}

/**
 * Отображаемое имя вложенного объекта `user`: `full_name`, при его
 * отсутствии или пустоте — `username`, нет ни того ни другого — `null`
 * (`kaiten-api-time.md`, вызов 1). Сам объект в форму ответа не входит —
 * он несёт base64-аватарку в несколько килобайт на запись.
 *
 * Объект `author` источником этого имени НЕ служит, даже когда `user` в
 * записи нет: подставить имя автора там, где нет пользователя, значит
 * приписать время не тому человеку (у записи, заведённой за другого, эти
 * двое различаются).
 */
function userDisplayName(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  return nonEmptyString(raw.full_name) ?? nonEmptyString(raw.username);
}

/** Непустая строка либо `null`: пустоту спека приравнивает к отсутствию ключа. */
function nonEmptyString(value: unknown): string | null {
  const text = stringOrNull(value);
  return text === "" ? null : text;
}

/**
 * Календарный день метки: сервер отдаёт `for_date` то чистой датой
 * (вызов 1), то полной ISO-меткой (ответы вызовов 2 и 3), а значим
 * только день.
 */
function calendarDay(value: string): string {
  return value.slice(0, 10);
}
