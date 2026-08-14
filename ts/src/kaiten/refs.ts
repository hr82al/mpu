/**
 * Каталог справочников и пользователя
 * (`docs/specs/platform/kaiten-api-refs.md`): шесть вызовов внешнего API —
 * владелец токена, лента его действий, оргструктура компании
 * (пространства → доски → дорожки/колонки) и определения кастомных полей.
 *
 * Слой — порт к внешней системе: форма запроса и разбор ответа, ничего
 * больше. Ни рендера, ни локального кэша: кэш справочников — надстройка
 * над этим каталогом (`./warmup.ts`), и ядру о нём не известно. Полнота
 * порта — требование спеки («Назначение»), поэтому объявлены все шесть
 * вызовов, включая те, у которых в этой волне команд ещё нет вызывающего
 * кода.
 *
 * Транспорт (доступ, retry, обе пагинации, формат ошибки) — `./http.ts`;
 * форма карточки на момент действия — соседний каталог `./cards.ts`.
 */

import {
  isRecord,
  type KaitenAccess,
  kaitenCall,
  kaitenCallArray,
  kaitenCallCursorPaged,
  type KaitenCallOptions,
  KaitenError,
  numberOrNull,
  stringOr,
  stringOrNull,
} from "./http.ts";
import { type CardSummary, parseCardSummary } from "./cards.ts";

/**
 * Владелец токена (ответ вызова 1). Отсутствующее в ответе поле — пустая
 * строка, не `null`: «нет значения» и «пустое значение» здесь неразличимы
 * и одинаково означают «показать нечего».
 */
export interface CurrentUser {
  readonly id: number;
  readonly fullName: string;
  readonly username: string;
  readonly email: string;
}

/** Событие ленты действий пользователя (элемент ответа вызова 2). */
export interface Activity {
  /** Строка: она же `cursor_id` следующего запроса. */
  readonly id: string;
  readonly created: string | null;
  readonly action: string;
  readonly cardId: number | null;
  /** Карточка на момент действия; `null` — действие к ней не привязано. */
  readonly card: CardSummary | null;
}

/**
 * Вход вызова 2. Умолчаний каталог не задаёт ни потолку, ни границе — их
 * называет командная спека, иначе глубина ленты стала бы свойством порта.
 */
export interface ActivityFeedRequest {
  /** Типы действий; уходят CSV-списком, по словарю сервер их не проверяет. */
  readonly actions: readonly string[];
  /** Потолок числа прочитанных страниц. */
  readonly maxPages: number;
  /** Нижняя граница `created` (ISO-8601); останов — на стороне клиента. */
  readonly minCreated?: string;
}

/** Доска компании (элемент вложенного `boards[]` вызова 3). */
export interface Board {
  readonly id: number;
  readonly spaceId: number;
  readonly title: string;
}

/** Пространство компании с вложенными досками (элемент ответа вызова 3). */
export interface Space {
  readonly id: number;
  readonly title: string;
  readonly archived: boolean;
  /** Единственный источник списка досок: своего справочника у них нет. */
  readonly boards: readonly Board[];
}

/** Дорожка одной доски (элемент ответа вызова 4). */
export interface Lane {
  readonly id: number;
  readonly boardId: number;
  readonly title: string;
}

/** Колонка одной доски (элемент ответа вызова 5). */
export interface Column {
  readonly id: number;
  readonly boardId: number;
  readonly title: string;
  /** Вес слева направо; порядок элементов массива его не повторяет. */
  readonly sortOrder: number | null;
}

/** Определение кастомного поля компании (элемент ответа вызова 6). */
export interface CustomProperty {
  readonly id: number;
  readonly name: string;
  readonly type: string | null;
}

/** 1. Владелец токена: его `id` — «мои» в фильтрах ленты и записей времени. */
export async function getCurrentUser(
  access: KaitenAccess,
  options: KaitenCallOptions = {},
): Promise<CurrentUser> {
  const path = "/users/current";
  const user = parseCurrentUser(
    await kaitenCall(access, { method: "GET", path }, options),
  );
  if (user === null) {
    throw new KaitenError(`kaiten GET ${path}: ответ не пользователь`);
  }
  return user;
}

/**
 * 2. Лента действий пользователя. Курсор наружу не выходит: страницы
 * обходит сам вызов, вызывающему достаётся их конкатенация в порядке
 * чтения. Нижняя граница даты в запрос не уходит — серверного фильтра по
 * дате у эндпоинта нет, и она только останавливает обход.
 */
export async function listUserActivities(
  access: KaitenAccess,
  feed: ActivityFeedRequest,
  options: KaitenCallOptions = {},
): Promise<readonly Activity[]> {
  const raw = await kaitenCallCursorPaged(
    access,
    {
      method: "GET",
      path: "/users/current/activities",
      query: { actions: feed.actions.join(",") },
    },
    { maxPages: feed.maxPages, minCreated: feed.minCreated },
    options,
  );
  return collect(raw, parseActivity);
}

/**
 * 3. Пространства компании вместе с их досками. Отдельного справочника
 * досок не существует (`GET /boards` отвечает 405) — вложенный `boards[]`
 * этого ответа единственный их источник.
 */
export async function listSpaces(
  access: KaitenAccess,
  options: KaitenCallOptions = {},
): Promise<readonly Space[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: "/spaces",
  }, options);
  return collect(raw, parseSpace);
}

/** 4. Дорожки одной доски; глобального их списка нет — запрос на доску. */
export async function listBoardLanes(
  access: KaitenAccess,
  boardId: number,
  options: KaitenCallOptions = {},
): Promise<readonly Lane[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: `/boards/${boardId}/lanes`,
  }, options);
  return collect(raw, parseLane);
}

/** 5. Колонки одной доски; как и дорожки, резолвятся по одной доске. */
export async function listBoardColumns(
  access: KaitenAccess,
  boardId: number,
  options: KaitenCallOptions = {},
): Promise<readonly Column[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: `/boards/${boardId}/columns`,
  }, options);
  return collect(raw, parseColumn);
}

/**
 * 6. Определения кастомных полей компании: пара `id → name` переводит
 * ключ `id_NNN` значений карточки в читаемое название поля.
 */
export async function listCustomProperties(
  access: KaitenAccess,
  options: KaitenCallOptions = {},
): Promise<readonly CustomProperty[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: "/company/custom-properties",
  }, options);
  return collect(raw, parseCustomProperty);
}

/** Элементы, не разобравшиеся в объявленную форму, в выдачу не попадают. */
function collect<T>(
  raw: readonly unknown[],
  parse: (item: unknown) => T | null,
): readonly T[] {
  const items: T[] = [];
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed !== null) items.push(parsed);
  }
  return items;
}

/** Разбор владельца токена; `null` — тело не пользователь. */
function parseCurrentUser(raw: unknown): CurrentUser | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    fullName: stringOr(raw.full_name, ""),
    username: stringOr(raw.username, ""),
    email: stringOr(raw.email, ""),
  };
}

/**
 * Разбор события ленты; `null` — элемент не событие. Событием его делает
 * СТРОКОВЫЙ `id`: он же курсор следующего запроса, и элемент без него
 * ленту дальше не двигает.
 */
function parseActivity(raw: unknown): Activity | null {
  if (!isRecord(raw)) return null;
  const id = stringOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    created: stringOrNull(raw.created),
    action: stringOr(raw.action, ""),
    cardId: numberOrNull(raw.card_id),
    card: parseCardSummary(raw.card),
  };
}

/** Разбор пространства вместе с его досками; `null` — не пространство. */
function parseSpace(raw: unknown): Space | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  const nested = Array.isArray(raw.boards) ? raw.boards : [];
  return {
    id,
    title: stringOr(raw.title, ""),
    archived: raw.archived === true,
    boards: collect(nested, (board) => parseBoard(board, id)),
  };
}

/** Разбор доски; `space_id` в ответе отсутствует — берётся от родителя. */
function parseBoard(raw: unknown, spaceId: number): Board | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    spaceId: numberOrNull(raw.space_id) ?? spaceId,
    title: stringOr(raw.title, ""),
  };
}

/** Разбор дорожки; `null` — нет числового `id` либо `board_id`. */
function parseLane(raw: unknown): Lane | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  const boardId = numberOrNull(raw.board_id);
  if (id === null || boardId === null) return null;
  return { id, boardId, title: stringOr(raw.title, "") };
}

/** Разбор колонки: та же пара обязательных полей плюс вес сортировки. */
function parseColumn(raw: unknown): Column | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  const boardId = numberOrNull(raw.board_id);
  if (id === null || boardId === null) return null;
  return {
    id,
    boardId,
    title: stringOr(raw.title, ""),
    sortOrder: numberOrNull(raw.sort_order),
  };
}

/** Разбор определения кастомного поля; `null` — нет числового `id`. */
function parseCustomProperty(raw: unknown): CustomProperty | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    name: stringOr(raw.name, ""),
    type: stringOrNull(raw.type),
  };
}
