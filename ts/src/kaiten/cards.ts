/**
 * Каталог карточки и её содержимого
 * (`docs/specs/platform/kaiten-api-cards.md`): 14 вызовов внешнего API —
 * список и полная карточка, комментарии и файлы, положение на доске,
 * описание, кастомные поля, чек-листы и история перемещений.
 *
 * Слой — порт к внешней системе: форма запроса и разбор ответа, ничего
 * больше. Рендер, резолв справочных ссылок и командная логика сюда не
 * входят — это дело командных спек. Полнота порта — требование спеки
 * («Назначение»), поэтому объявлены все 14 вызовов, включая те, у которых
 * в этой волне команд ещё нет вызывающего кода.
 *
 * Транспорт (доступ, retry, пагинация, multipart, формат ошибки) —
 * `./http.ts`; форма таймера — соседний каталог `./time.ts`: вложенный в
 * карточку таймер и ответы его запуска и остановки — один и тот же
 * `Timer`.
 */

import {
  isRecord,
  type KaitenAccess,
  kaitenCall,
  kaitenCallArray,
  type KaitenCallOptions,
  kaitenCallPaged,
  KaitenError,
  type KaitenFormRequest,
  type KaitenRequest,
  numberOrNull,
  stringOr,
  stringOrNull,
} from "./http.ts";
import type { MultipartPart } from "../http/mod.ts";
import { parseTimer, type Timer } from "./time.ts";

/** Состояние карточки: закрытый список поля `state` (вызов 1). */
export type CardState = 1 | 2 | 3;

/** Условие карточки: `1` активные, `2` архивные (вызов 1). */
export type CardCondition = 1 | 2;

/**
 * Фильтры выдачи списка карточек (вызов 1) — все необязательны. Имена
 * параметров точны: неизвестное имя сервер молча игнорирует, и фильтр
 * просто не применяется.
 */
export interface CardFilter {
  /** Id участников карточки — роль «участник». */
  readonly memberIds?: readonly number[];
  /** Id ОТВЕТСТВЕННОГО: отдельная ось, не синоним и не замена участникам. */
  readonly responsibleId?: number;
  readonly condition?: CardCondition;
  readonly states?: readonly CardState[];
  readonly spaceId?: number;
  readonly boardId?: number;
  /** Единственного числа: плюральный `lane_ids` сервер молча игнорирует. */
  readonly laneId?: number;
  readonly columnId?: number;
  /** Окно по полю `updated` карточки: ISO-8601 `YYYY-MM-DDThh:mm:ssZ`. */
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
}

/** Пользователь в составе карточки: участник, владелец, автор комментария. */
export interface Member {
  readonly id: number;
  readonly fullName: string;
  /** У автора комментария почты в ответе нет — там `null`. */
  readonly email: string | null;
  readonly username: string;
}

/** Файл карточки: уровня карточки, комментария либо кастомного поля. */
export interface CardFile {
  readonly id: number;
  readonly url: string;
  readonly name: string;
  readonly mimeType: string | null;
  /** `null` — файл уровня карточки, иначе id комментария-владельца. */
  readonly commentId: number | null;
  readonly cardCover: boolean;
  /** `null` — файл не привязан к полю, иначе id кастомного файлового поля. */
  readonly customPropertyId: number | null;
}

/** Пункт чек-листа (ответ вызовов 11 и 12). */
export interface ChecklistItem {
  readonly id: number;
  readonly text: string;
  readonly checked: boolean;
  /** Вес сортировки среди пунктов чек-листа. */
  readonly sortOrder: number | null;
}

/** Чек-лист карточки: имя и пункты (ответ вызова 10). */
export interface Checklist {
  readonly id: number;
  readonly name: string;
  /**
   * Пункты в порядке ответа сервера; порядка каталог не обещает — он не
   * совпадает ни с `id`, ни с `sortOrder`. Порядок пунктов даёт только
   * `sortOrder`, и сортировка принадлежит вызывающему.
   */
  readonly items: readonly ChecklistItem[];
}

/** Комментарий карточки (ответ вызовов 3, 4, 5); текст — GFM markdown. */
export interface Comment {
  readonly id: number;
  readonly text: string;
  readonly created: string | null;
  readonly author: Member | null;
}

/** Карточка в выдаче списка (элемент ответа вызова 1). */
export interface CardSummary {
  readonly id: number;
  readonly title: string;
  readonly state: number;
  readonly condition: number;
  readonly dueDate: string | null;
  readonly updated: string | null;
  readonly boardId: number | null;
  readonly columnId: number | null;
  readonly laneId: number | null;
  readonly archived: boolean;
  readonly lastMovedAt: string | null;
  /** Сумма минут по карточке ВСЕМИ участниками, не одним пользователем. */
  readonly timeSpentSum: number | null;
  readonly boardTitle: string | null;
  /** Пространства доски: сервер несёт их списком, первое ничем не выделено. */
  readonly spaceTitles: readonly string[];
  readonly columnTitle: string | null;
  readonly laneTitle: string | null;
  readonly typeName: string | null;
}

/** Карточка целиком (ответ вызовов 2, 6, 7, 8). */
export interface Card {
  readonly id: number;
  /** Человекочитаемый код карточки. */
  readonly key: string | null;
  readonly title: string;
  readonly state: number;
  readonly condition: number;
  readonly dueDate: string | null;
  readonly sizeText: string | null;
  readonly created: string | null;
  readonly updated: string | null;
  /** GFM markdown; интерактивных чекбоксов редактор описания не знает. */
  readonly description: string | null;
  /** Сумма минут по карточке ВСЕМИ участниками. */
  readonly timeSpentSum: number | null;
  readonly boardId: number | null;
  readonly boardTitle: string | null;
  readonly columnId: number | null;
  readonly columnTitle: string | null;
  /** У дорожки полной карточки приходит только название. */
  readonly laneTitle: string | null;
  readonly typeName: string | null;
  readonly owner: Member | null;
  /**
   * ТОЛЬКО таймер текущего пользователя по токену, не любой запущенный на
   * карточке; `null` — не запущен и он.
   */
  readonly timer: Timer | null;
  /** Имена тегов: на проводе тег — объект, значимо в нём только имя. */
  readonly tags: readonly string[];
  readonly members: readonly Member[];
  readonly files: readonly CardFile[];
  /**
   * Значения кастомных полей; ключи вида `id_NNN`. Значение — строка
   * либо массив: файловое (attachment) поле несёт массив uid привязанных
   * файлов.
   */
  readonly properties: Readonly<Record<string, string | readonly string[]>>;
  readonly checklists: readonly Checklist[];
}

/** Запись истории перемещений карточки (элемент ответа вызова 9). */
export interface LocationChange {
  readonly cardId: number;
  readonly columnId: number | null;
  readonly laneId: number | null;
  readonly authorId: number | null;
  readonly authorName: string | null;
  /** Момент смены, ISO-8601 UTC. */
  readonly changed: string | null;
}

/** Место карточки на доске (вызов 6): заданные оси — те, что меняются. */
export interface CardLocation {
  readonly boardId?: number;
  readonly columnId?: number;
  readonly laneId?: number;
}

/**
 * Значения кастомных полей для вызова 8: ключи вида `id_NNN`, `null` —
 * очистка поля, а не пропуск ключа.
 */
export type CardProperties = Readonly<Record<string, string | null>>;

/** Создаваемый пункт чек-листа (вызов 11). */
export interface NewChecklistItem {
  readonly text: string;
  readonly checked: boolean;
  /** Не задан — сервер ставит пункт в конец списка. */
  readonly sortOrder?: number;
}

/** Изменяемые поля пункта чек-листа (вызов 12). */
export interface ChecklistItemPatch {
  readonly checked: boolean;
}

/** Файл, уходящий в multipart-теле вызовов 5 и 13. */
export interface UploadFile {
  /** Имя файла в part'е; экранирование — дело транспорта. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** 1. Список карточек по фильтрам; страницы склеиваются транспортом. */
export async function listCards(
  access: KaitenAccess,
  filter: CardFilter = {},
  options: KaitenCallOptions = {},
): Promise<readonly CardSummary[]> {
  const raw = await kaitenCallPaged(access, {
    method: "GET",
    path: "/cards",
    query: cardsQuery(filter),
  }, options);
  return collect(raw, parseCardSummary);
}

/** 2. Карточка целиком — с участниками, файлами, полями и чек-листами. */
export async function getCard(
  access: KaitenAccess,
  cardId: number,
  options: KaitenCallOptions = {},
): Promise<Card> {
  const request: KaitenRequest = {
    method: "GET",
    path: `/cards/${cardId}`,
  };
  return requireForm(
    request,
    await kaitenCall(access, request, options),
    parseCard,
    "карточка",
  );
}

/**
 * 3. Комментарии карточки; без комментариев — пустой список, не ошибка.
 * Порядок — тот, в котором ответил сервер, и порядка каталог не обещает:
 * ответ не упорядочен ни по `created`, ни по `id`. Нужна хронология —
 * сортирует вызывающий.
 */
export async function listCardComments(
  access: KaitenAccess,
  cardId: number,
  options: KaitenCallOptions = {},
): Promise<readonly Comment[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: `/cards/${cardId}/comments`,
  }, options);
  return collect(raw, parseComment);
}

/** 4. Комментарий без вложений: тело — JSON с одним текстом. */
export async function createCardComment(
  access: KaitenAccess,
  cardId: number,
  text: string,
  options: KaitenCallOptions = {},
): Promise<Comment> {
  const request: KaitenRequest = {
    method: "POST",
    path: `/cards/${cardId}/comments`,
    body: { text },
  };
  return requireForm(
    request,
    await kaitenCall(access, request, options),
    parseComment,
    "комментарий",
  );
}

/**
 * 5. Комментарий с файлами: тело `multipart/form-data` — поле `text` и по
 * part'у `files[]` на файл. Ответ — «Комментарий»: приложенных файлов эта
 * форма не несёт, их привязку показывает `comment_id` файла полной
 * карточки (вызов 2).
 */
export async function createCardCommentWithFiles(
  access: KaitenAccess,
  cardId: number,
  text: string,
  files: readonly UploadFile[],
  options: KaitenCallOptions = {},
): Promise<Comment> {
  const request: KaitenFormRequest = {
    method: "POST",
    path: `/cards/${cardId}/comments`,
    form: [
      { kind: "field", name: "text", value: text },
      ...files.map((file) => filePart("files[]", file)),
    ],
  };
  return requireForm(
    request,
    await kaitenCall(access, request, options),
    parseComment,
    "комментарий",
  );
}

/** 6. Перемещение карточки: в теле только заданные оси места. */
export function moveCard(
  access: KaitenAccess,
  cardId: number,
  location: CardLocation,
  options: KaitenCallOptions = {},
): Promise<Card> {
  const body: Record<string, unknown> = {};
  if (location.boardId !== undefined) body.board_id = location.boardId;
  if (location.columnId !== undefined) body.column_id = location.columnId;
  if (location.laneId !== undefined) body.lane_id = location.laneId;

  return patchCard(access, cardId, body, options);
}

/** 7. Описание карточки: полная замена содержимого, не патч фрагмента. */
export function updateCardDescription(
  access: KaitenAccess,
  cardId: number,
  description: string,
  options: KaitenCallOptions = {},
): Promise<Card> {
  return patchCard(access, cardId, { description }, options);
}

/** 8. Значения кастомных полей; `null` — очистка поля. */
export function updateCardProperties(
  access: KaitenAccess,
  cardId: number,
  properties: CardProperties,
  options: KaitenCallOptions = {},
): Promise<Card> {
  return patchCard(access, cardId, { properties }, options);
}

/** 9. История перемещений; без перемещений — пустой список, не ошибка. */
export async function listCardLocationHistory(
  access: KaitenAccess,
  cardId: number,
  options: KaitenCallOptions = {},
): Promise<readonly LocationChange[]> {
  const raw = await kaitenCallArray(access, {
    method: "GET",
    path: `/cards/${cardId}/location-history`,
  }, options);
  return collect(raw, parseLocationChange);
}

/** 10. Чек-лист карточки; сразу после создания его список пунктов пуст. */
export async function createCardChecklist(
  access: KaitenAccess,
  cardId: number,
  name: string,
  options: KaitenCallOptions = {},
): Promise<Checklist> {
  const request: KaitenRequest = {
    method: "POST",
    path: `/cards/${cardId}/checklists`,
    body: { name },
  };
  return requireForm(
    request,
    await kaitenCall(access, request, options),
    parseChecklist,
    "чек-лист",
  );
}

/** 11. Пункт чек-листа; без `sortOrder` сервер ставит его в конец списка. */
export async function createChecklistItem(
  access: KaitenAccess,
  cardId: number,
  checklistId: number,
  item: NewChecklistItem,
  options: KaitenCallOptions = {},
): Promise<ChecklistItem> {
  const body: Record<string, unknown> = {
    text: item.text,
    checked: item.checked,
  };
  if (item.sortOrder !== undefined) body.sort_order = item.sortOrder;

  const request: KaitenRequest = {
    method: "POST",
    path: `/cards/${cardId}/checklists/${checklistId}/items`,
    body,
  };
  return requireForm(
    request,
    await kaitenCall(access, request, options),
    parseChecklistItem,
    "пункт чек-листа",
  );
}

/** 12. Отметка пункта; ответ — тот же пункт с новым значением `checked`. */
export async function updateChecklistItem(
  access: KaitenAccess,
  cardId: number,
  checklistId: number,
  itemId: number,
  patch: ChecklistItemPatch,
  options: KaitenCallOptions = {},
): Promise<ChecklistItem> {
  const request: KaitenRequest = {
    method: "PATCH",
    path: `/cards/${cardId}/checklists/${checklistId}/items/${itemId}`,
    body: { checked: patch.checked },
  };
  return requireForm(
    request,
    await kaitenCall(access, request, options),
    parseChecklistItem,
    "пункт чек-листа",
  );
}

/**
 * 13. Файл в файловое (attachment) кастомное поле: тело
 * `multipart/form-data` с единственным полем `file`. Только этот вызов
 * заполняет поле — обычная загрузка файла карточки его не трогает.
 */
export async function uploadCustomPropertyFile(
  access: KaitenAccess,
  cardId: number,
  propertyId: number,
  file: UploadFile,
  options: KaitenCallOptions = {},
): Promise<CardFile> {
  const request: KaitenFormRequest = {
    method: "PUT",
    path: `/cards/${cardId}/custom-properties/${propertyId}/files`,
    form: [filePart("file", file)],
  };
  return requireForm(
    request,
    await kaitenCall(access, request, options),
    parseCardFile,
    "файл",
  );
}

/**
 * 14. Удалить файл карточки. Файл, привязанный к кастомному полю,
 * очищает и значение этого поля — отдельного вызова на очистку не нужно.
 */
export async function deleteCardFile(
  access: KaitenAccess,
  cardId: number,
  fileId: number,
  options: KaitenCallOptions = {},
): Promise<void> {
  await kaitenCall(access, {
    method: "DELETE",
    path: `/cards/${cardId}/files/${fileId}`,
  }, options);
}

/**
 * Общий PATCH карточки: вызовы 6, 7 и 8 отличаются только телом, а путь,
 * метод и форма ответа у них одни. Причина изменения тоже одна — контракт
 * `PATCH /cards/{id}`.
 */
async function patchCard(
  access: KaitenAccess,
  cardId: number,
  body: Record<string, unknown>,
  options: KaitenCallOptions,
): Promise<Card> {
  const request: KaitenRequest = {
    method: "PATCH",
    path: `/cards/${cardId}`,
    body,
  };
  return requireForm(
    request,
    await kaitenCall(access, request, options),
    parseCard,
    "карточка",
  );
}

/** Файловая часть тела: имя поля задаёт вызов, имя файла — вызывающий. */
function filePart(name: string, file: UploadFile): MultipartPart {
  return { kind: "file", name, filename: file.name, bytes: file.bytes };
}

/** Query вызова 1: заданные фильтры; лимит и смещение добавит транспорт. */
function cardsQuery(filter: CardFilter): Record<string, string> {
  const query: Record<string, string> = {};
  if (filter.memberIds !== undefined) {
    query.member_ids = filter.memberIds.join(",");
  }
  if (filter.responsibleId !== undefined) {
    query.responsible_id = String(filter.responsibleId);
  }
  if (filter.condition !== undefined) {
    query.condition = String(filter.condition);
  }
  if (filter.states !== undefined) query.states = filter.states.join(",");
  if (filter.spaceId !== undefined) query.space_id = String(filter.spaceId);
  if (filter.boardId !== undefined) query.board_id = String(filter.boardId);
  if (filter.laneId !== undefined) query.lane_id = String(filter.laneId);
  if (filter.columnId !== undefined) query.column_id = String(filter.columnId);
  if (filter.updatedAfter !== undefined) {
    query.updated_after = filter.updatedAfter;
  }
  if (filter.updatedBefore !== undefined) {
    query.updated_before = filter.updatedBefore;
  }
  return query;
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

/** Ответ одиночного вызова обязан разобраться в объявленную форму. */
function requireForm<T>(
  request: KaitenRequest,
  raw: unknown,
  parse: (raw: unknown) => T | null,
  form: string,
): T {
  const parsed = parse(raw);
  if (parsed === null) {
    throw new KaitenError(
      `kaiten ${request.method} ${request.path}: ответ не ${form}`,
    );
  }
  return parsed;
}

/**
 * Разбор карточки списка; `null` — тело не карточка (нет числового `id`).
 * Экспортируется мимо `mod.ts` соседнему каталогу справочников: карточка на
 * момент действия в ленте — та же форма, что элемент `GET /cards`
 * (`kaiten-api-refs.md`, вызов 2), и второй её разбор разошёлся бы с этим.
 */
export function parseCardSummary(raw: unknown): CardSummary | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;

  const board = nested(raw.board);
  return {
    id,
    title: stringOr(raw.title, ""),
    state: numberOrNull(raw.state) ?? 0,
    condition: numberOrNull(raw.condition) ?? 0,
    dueDate: stringOrNull(raw.due_date),
    updated: stringOrNull(raw.updated),
    boardId: numberOrNull(raw.board_id),
    columnId: numberOrNull(raw.column_id),
    laneId: numberOrNull(raw.lane_id),
    archived: raw.archived === true,
    lastMovedAt: stringOrNull(raw.last_moved_at),
    timeSpentSum: numberOrNull(raw.time_spent_sum),
    boardTitle: stringOrNull(board.title),
    spaceTitles: spaceTitles(board.spaces),
    columnTitle: nestedTitle(raw.column),
    laneTitle: nestedTitle(raw.lane),
    typeName: nestedName(raw.type),
  };
}

/** Разбор полной карточки; `null` — тело не карточка. */
function parseCard(raw: unknown): Card | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;

  const board = nested(raw.board);
  const column = nested(raw.column);
  return {
    id,
    key: stringOrNull(raw.key),
    title: stringOr(raw.title, ""),
    state: numberOrNull(raw.state) ?? 0,
    condition: numberOrNull(raw.condition) ?? 0,
    dueDate: stringOrNull(raw.due_date),
    sizeText: stringOrNull(raw.size_text),
    created: stringOrNull(raw.created),
    updated: stringOrNull(raw.updated),
    description: stringOrNull(raw.description),
    timeSpentSum: numberOrNull(raw.time_spent_sum),
    boardId: numberOrNull(board.id),
    boardTitle: stringOrNull(board.title),
    columnId: numberOrNull(column.id),
    columnTitle: stringOrNull(column.title),
    laneTitle: nestedTitle(raw.lane),
    typeName: nestedName(raw.type),
    owner: parseMember(raw.owner),
    timer: parseTimer(raw.timer),
    tags: collect(array(raw.tags), nestedName),
    members: collect(array(raw.members), parseMember),
    files: collect(array(raw.files), parseCardFile),
    properties: parseProperties(raw.properties),
    checklists: collect(array(raw.checklists), parseChecklist),
  };
}

/** Разбор участника; `null` — объекта нет либо у него нет числового `id`. */
function parseMember(raw: unknown): Member | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    fullName: stringOr(raw.full_name, ""),
    email: stringOrNull(raw.email),
    username: stringOr(raw.username, ""),
  };
}

/** Разбор файла карточки; `null` — тело не файл. */
function parseCardFile(raw: unknown): CardFile | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    url: stringOr(raw.url, ""),
    name: stringOr(raw.name, ""),
    mimeType: stringOrNull(raw.mime_type),
    commentId: numberOrNull(raw.comment_id),
    cardCover: raw.card_cover === true,
    customPropertyId: numberOrNull(raw.custom_property_id),
  };
}

/** Разбор комментария; `null` — тело не комментарий. */
function parseComment(raw: unknown): Comment | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    text: stringOr(raw.text, ""),
    created: stringOrNull(raw.created),
    author: parseMember(raw.author),
  };
}

/** Разбор чек-листа; `null` — тело не чек-лист. */
function parseChecklist(raw: unknown): Checklist | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    name: stringOr(raw.name, ""),
    items: collect(array(raw.items), parseChecklistItem),
  };
}

/** Разбор пункта чек-листа; служебные поля пункта в форму не входят. */
function parseChecklistItem(raw: unknown): ChecklistItem | null {
  if (!isRecord(raw)) return null;
  const id = numberOrNull(raw.id);
  if (id === null) return null;
  return {
    id,
    text: stringOr(raw.text, ""),
    checked: raw.checked === true,
    sortOrder: numberOrNull(raw.sort_order),
  };
}

/** Разбор записи истории; `null` — элемент не запись перемещения. */
function parseLocationChange(raw: unknown): LocationChange | null {
  if (!isRecord(raw)) return null;
  const cardId = numberOrNull(raw.card_id);
  if (cardId === null) return null;
  return {
    cardId,
    columnId: numberOrNull(raw.column_id),
    laneId: numberOrNull(raw.lane_id),
    authorId: numberOrNull(raw.author_id),
    authorName: stringOrNull(raw.author_name),
    changed: stringOrNull(raw.changed),
  };
}

/** Значения кастомных полей; поле без значения в объект не попадает. */
function parseProperties(
  raw: unknown,
): Readonly<Record<string, string | readonly string[]>> {
  if (!isRecord(raw)) return {};
  const properties: Record<string, string | readonly string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parsePropertyValue(value);
    if (parsed !== null) properties[key] = parsed;
  }
  return properties;
}

/**
 * Значение кастомного поля: строка либо массив uid файлового поля
 * (`kaiten-api-cards.md`, «Инварианты»). Прочее — `null`, «значения нет»:
 * так сервер шлёт пустое поле. Элемент массива не-строка отбрасывается по
 * тому же правилу, что элемент любого другого списка каталога.
 */
function parsePropertyValue(raw: unknown): string | readonly string[] | null {
  if (!Array.isArray(raw)) return stringOrNull(raw);
  return raw.filter((item): item is string => typeof item === "string");
}

/**
 * Вложенный объект как запись; его нет в ответе — пустая. Пустая, а не
 * `null`: поля вложенного объекта читаются одинаково и когда он пришёл, и
 * когда нет, — «значения нет» и так выражает `null` каждого поля.
 */
function nested(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

/** Название вложенного объекта места (`board`, `column`, `lane`). */
function nestedTitle(raw: unknown): string | null {
  return stringOrNull(nested(raw).title);
}

/** Имя вложенного объекта: тип карточки (`type`), тег (`tags`). */
function nestedName(raw: unknown): string | null {
  return stringOrNull(nested(raw).name);
}

/** Названия пространств доски: сервер несёт их списком объектов. */
function spaceTitles(raw: unknown): readonly string[] {
  return collect(array(raw), nestedTitle);
}

/** Значение как список: не массив — пустой список. */
function array(raw: unknown): readonly unknown[] {
  return Array.isArray(raw) ? raw : [];
}
