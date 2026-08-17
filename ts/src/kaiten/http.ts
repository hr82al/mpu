/**
 * Транспорт Kaiten API (`docs/specs/platform/kaiten-http.md`): доступ
 * (базовый URL и токен), форма запроса, retry на 429, формат ошибки
 * не-2xx, разбор тела ответа. Ни одного вызова по имени этот файл не
 * знает — перечни вызовов лежат в каталогах внешней границы
 * (`platform/kaiten-api-*.md`).
 *
 * Ниже транспорта — общий `httpSend` (`../http/mod.ts`): пределы времени
 * одного вызова и причина сетевого отказа одной строкой там уже решены;
 * здесь — только трактовка протокола Kaiten.
 *
 * Файл вынесен из `src/init/`: это платформенный атом, а не часть
 * команды init, и у него появляются другие потребители — каталоги
 * внешнего API.
 */

import {
  DEFAULT_TIMEOUTS,
  HttpCallError,
  httpSend,
  type RequestTimeouts,
} from "../http/mod.ts";
import { buildMultipartBody, type MultipartPart } from "./multipart.ts";

/** Дефолт `KITEN_BASE_URL`, когда переменная не задана (`kaiten-http.md`). */
const DEFAULT_BASE_URL = "https://btlz.kaiten.ru";
/** Единственный автоповторяемый статус — 429, до 6 попыток на запрос. */
const MAX_ATTEMPTS = 6;
/** База и потолок экспоненциального backoff, когда `Retry-After` не пришёл. */
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_CAP_MS = 30_000;
/** Тело ошибки не-2xx обрезается до 300 символов (`kaiten-http.md`). */
const ERROR_BODY_LIMIT = 300;
/**
 * Размер страницы обеих пагинаций. В offset-режиме больший сервер молча
 * уменьшает до него, в курсорном — отвергает статусом 400; сотня годится
 * обоим, поэтому предел зашит, а не отдан вызывающему.
 */
const PAGE_LIMIT = 100;
/** Причина пропуска доски при исчерпании бюджета шага (`init.md`, шаг 4). */
const BUDGET_EXHAUSTED_REASON = "бюджет шага исчерпан";

/** Подключение к Kaiten API. */
export interface KaitenAccess {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** Что несёт отказ Kaiten сверх текста: ответ не-2xx, если он был. */
export interface KaitenErrorDetails extends ErrorOptions {
  /** HTTP-статус ответа; у сетевого отказа и отказа разбора его нет. */
  readonly status?: number;
  /**
   * Тело ответа как есть, без обрезки. Нужно вызывающему, который
   * различает формы отказа ПО ТЕЛУ, а не по коду: конфликт таймера
   * приходит статусом 400 и узнаётся по составу тела
   * (`platform/kaiten-api-time.md`, вызов 6).
   */
  readonly body?: string;
}

/** Сбой обращения к Kaiten; сообщение — «<причина>» одной строкой. */
export class KaitenError extends Error {
  override name = "KaitenError";
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, opts?: KaitenErrorDetails) {
    super(message, { cause: opts?.cause });
    this.status = opts?.status;
    this.body = opts?.body;
  }
}

/**
 * Базовый URL Kaiten из env-файла. Ключа доступа не требует: web-URL
 * карточки строится и там, где живой опрос не идёт вовсе
 * (`docs/specs/telegram-status.md`, journal без `--live`).
 *
 * Хвостовые `/` срезаются той же нормализацией, что у
 * `requirePortainerAccess` (`../init/cmd_init.ts`) и `requireLokiAccess`
 * (`../loki/mod.ts`): путь строится конкатенацией
 * `baseUrl + "/api/latest" + path`, лишний `/` сложил бы двойной слэш.
 */
export function kaitenBaseUrl(
  envFile: { readonly get: (name: string) => string | undefined },
): string {
  return (envFile.get("KITEN_BASE_URL") ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

/** Подключение из env-файла; нет KITEN_API_KEY — KaitenError («KITEN_API_KEY не задан»). */
export function requireKaitenAccess(
  envFile: { readonly get: (name: string) => string | undefined },
): KaitenAccess {
  const apiKey = envFile.get("KITEN_API_KEY");
  if (apiKey === undefined || apiKey === "") {
    throw new KaitenError("KITEN_API_KEY не задан");
  }
  return { baseUrl: kaitenBaseUrl(envFile), apiKey };
}

/**
 * Пауза перед повтором 429 в мс: чистая функция расписания, тестируется
 * без сна. `Retry-After` — целое число секунд (`kaiten-http.md`);
 * отсутствие заголовка или нечисловое значение — экспоненциальный backoff
 * 1s, ×2 за попытку, потолок 30s.
 */
export function retryDelayMs(
  attempt: number,
  retryAfter: string | null,
): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  return Math.min(
    RETRY_BACKOFF_CAP_MS,
    RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1),
  );
}

/** Метод запроса Kaiten API (`kaiten-http.md`, «Запрос»). */
export type KaitenMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * Один запрос к Kaiten API: путь — под `{base}/api/latest`, `body` —
 * значение, которое уходит JSON-телом (`undefined` — тела нет).
 */
export interface KaitenRequest {
  readonly method: KaitenMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/**
 * Тот же запрос с телом `multipart/form-data` вместо JSON-тела: его
 * требуют вызовы каталогов, принимающие файлы. Отдельный тип, а не второе
 * необязательное поле рядом с `body`: два способа задать тело в одном
 * объекте пришлось бы разбирать в пользу одного из них молча, а так
 * «ровно один» проверяет компилятор.
 */
export interface KaitenFormRequest extends KaitenRequest {
  readonly body?: undefined;
  readonly form: readonly MultipartPart[];
}

/** Что вызывающий добавляет к запросу сверх его формы. */
export interface KaitenCallOptions {
  /** Пределы времени вызова; умолчание — числа спеки для всех вызовов. */
  readonly timeouts?: RequestTimeouts;
  /**
   * Накопитель строк повтора 429. Печатает их потребитель, поэтому
   * строки собираются в переданный массив, а не возвращаются вместе с
   * результатом: при исчерпании попыток или срабатывании бюджета вызов
   * бросает исключение, а строки об уже прошедших паузах обязаны
   * остаться видны (см. `./warmup.ts`).
   */
  readonly notes?: string[];
  /**
   * Предел времени шага-потребителя: после него не выполняются ни
   * запрос, ни пауза retry (`init.md`, шаг 4). Не задан — вызов
   * ограничен только собственными пределами времени.
   */
  readonly deadlineMs?: number | null;
  readonly nowMs?: () => number;
}

/**
 * Один вызов Kaiten API с retry на 429 (до `MAX_ATTEMPTS` попыток) и
 * учётом бюджета шага. Результат — разобранное тело ответа; пустое тело
 * (успех без данных) — `undefined`, а не ошибка разбора
 * (`kaiten-http.md`, «Запрос»).
 *
 * Повтор безопасен и для мутирующих методов: 429 означает «запрос не
 * обработан» (инвариант спеки), поэтому попытка повторяется целиком —
 * с тем же телом.
 */
export async function kaitenCall(
  access: KaitenAccess,
  request: KaitenRequest | KaitenFormRequest,
  options: KaitenCallOptions = {},
): Promise<unknown> {
  const url = new URL(`${access.baseUrl}/api/latest${request.path}`);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(name, value);
  }

  const { body, contentType } = requestBody(request);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.apiKey}`,
    Accept: "application/json",
  };
  if (contentType !== undefined) headers["Content-Type"] = contentType;

  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const deadlineMs = options.deadlineMs ?? null;
  const nowMs = options.nowMs ?? Date.now;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    assertBudget(deadlineMs, nowMs);

    let response;
    try {
      response = await httpSend(url, {
        method: request.method,
        headers,
        body,
        timeouts,
      });
    } catch (err) {
      // `httpSend` бросает только `HttpCallError` — сообщение уже одной
      // строкой (её собственный инвариант, `../http/mod.ts`), поэтому
      // переносится как есть, без повторного прогона через `firstLine`.
      if (!(err instanceof HttpCallError)) throw err;
      throw new KaitenError(err.message, { cause: err });
    }

    if (response.status >= 200 && response.status < 300) {
      return parseBody(request, response.text);
    }

    if (response.status === 429) {
      if (attempt === MAX_ATTEMPTS) throw exhaustedRetries(request);
      assertBudget(deadlineMs, nowMs);
      const delayMs = retryDelayMs(attempt, response.retryAfter);
      options.notes?.push(`[kaiten] 429 rate-limit, sleep ${delayMs / 1000}s`);
      await sleep(delayMs);
      continue;
    }

    throw new KaitenError(
      `kaiten ${request.method} ${request.path} -> ${response.status}: ${
        truncateBody(response.text)
      }`,
      { status: response.status, body: response.text },
    );
  }
  // Недостижимо: цикл на каждой итерации либо возвращает, либо бросает —
  // но `for` не даёт компилятору это увидеть, а без завершающего throw
  // функция не проходит проверку «не все пути возвращают значение».
  throw exhaustedRetries(request);
}

/**
 * Тот же вызов там, где контракт операции обещает массив. Валидный JSON
 * не той формы — ошибка запроса, а не пустой список (`kaiten-http.md`,
 * «Запрос»): иначе испорченный ответ молча заменил бы справочник
 * пустым, и пустой справочник от испорченного ответа было бы не
 * отличить. Отличие от Loki, где пустой результат на неожиданную форму
 * — явное требование его спеки.
 */
export async function kaitenCallArray(
  access: KaitenAccess,
  request: KaitenRequest,
  options: KaitenCallOptions = {},
): Promise<readonly unknown[]> {
  const parsed = await kaitenCall(access, request, options);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new KaitenError(
      `kaiten ${request.method} ${request.path}: ответ не JSON-массив`,
    );
  }
  return parsed;
}

/**
 * Полный список offset-пагинации (`kaiten-http.md`, «Пагинация»):
 * `limit=100`, `offset` 0, 100, 200…; останов — первая страница короче
 * лимита (пустая — её частный случай). Результат — конкатенация страниц в
 * порядке запросов. Поднимать лимит нельзя: больший сервер молча
 * уменьшает до сотни.
 */
export async function kaitenCallPaged(
  access: KaitenAccess,
  request: KaitenRequest,
  options: KaitenCallOptions = {},
): Promise<readonly unknown[]> {
  const items: unknown[] = [];
  for (let offset = 0;; offset += PAGE_LIMIT) {
    const page = await kaitenCallArray(access, {
      ...request,
      query: {
        ...request.query,
        limit: String(PAGE_LIMIT),
        offset: String(offset),
      },
    }, options);
    items.push(...page);
    if (page.length < PAGE_LIMIT) return items;
  }
}

/** Глубина курсорного обхода: умолчаний спека не задаёт ни одному пределу. */
export interface CursorPageLimits {
  /** Потолок числа прочитанных страниц. */
  readonly maxPages: number;
  /**
   * Нижняя граница `created` (ISO-8601). Останов — на стороне клиента:
   * серверного фильтра по дате у эндпоинта нет (`from`/`to`/`since` он
   * принимает и игнорирует), поэтому в запрос граница не уходит.
   */
  readonly minCreated?: string;
}

/** Курсор ленты: пара (момент, id) последнего элемента страницы. */
interface ActivityCursor {
  readonly created: string;
  readonly id: string;
}

/** Пустая пара — «с начала»: так сервер и трактует пустой курсор. */
const EMPTY_CURSOR: ActivityCursor = { created: "", id: "" };

/**
 * Полный список курсорной пагинации (`kaiten-http.md`, «Пагинация»):
 * каждый запрос несёт `offset=0`, `limit=100` и курсор последнего элемента
 * предыдущей страницы. Результат — конкатенация прочитанных страниц в
 * порядке чтения; страницы отдаются целиком, `minCreated` только
 * останавливает обход.
 *
 * Останов — короткая страница (пустая — её частный случай), исчерпанный
 * потолок страниц, отсутствие курсорных полей у последнего элемента либо
 * его `created` меньше `minCreated` (строки ISO-8601 сравниваются
 * лексикографически).
 */
export async function kaitenCallCursorPaged(
  access: KaitenAccess,
  request: KaitenRequest,
  limits: CursorPageLimits,
  options: KaitenCallOptions = {},
): Promise<readonly unknown[]> {
  const items: unknown[] = [];
  let cursor = EMPTY_CURSOR;
  for (let page = 0; page < limits.maxPages; page++) {
    const chunk = await kaitenCallArray(access, {
      ...request,
      query: {
        ...request.query,
        offset: "0",
        limit: String(PAGE_LIMIT),
        cursor_created: cursor.created,
        cursor_id: cursor.id,
      },
    }, options);
    items.push(...chunk);
    if (chunk.length < PAGE_LIMIT) return items;

    const next = activityCursor(chunk[chunk.length - 1]);
    if (next === null) return items;
    if (limits.minCreated !== undefined && next.created < limits.minCreated) {
      return items;
    }
    cursor = next;
  }
  return items;
}

/** Курсор элемента; `null` — курсорных полей у него нет, обход окончен. */
function activityCursor(item: unknown): ActivityCursor | null {
  if (!isRecord(item)) return null;
  const created = stringOrNull(item.created);
  const id = stringOrNull(item.id);
  return created === null || id === null ? null : { created, id };
}

/**
 * Тело запроса и заголовок его типа: JSON-значение, части
 * `multipart/form-data` либо ничего. Граница multipart генерируется на
 * запрос (`kaiten-http.md`, «Запрос»).
 */
function requestBody(request: KaitenRequest | KaitenFormRequest): {
  readonly body?: string | Uint8Array<ArrayBuffer>;
  readonly contentType?: string;
} {
  if ("form" in request) {
    const built = buildMultipartBody(
      request.form,
      `mpu-${crypto.randomUUID()}`,
    );
    return { body: built.bytes, contentType: built.contentType };
  }
  if (request.body === undefined) return {};
  return {
    body: JSON.stringify(request.body),
    contentType: "application/json",
  };
}

function exhaustedRetries(request: KaitenRequest): KaitenError {
  return new KaitenError(
    `kaiten ${request.method} ${request.path} -> 429: exhausted retries`,
  );
}

/** Бросает `KaitenError` с причиной бюджета, если дедлайн уже прошёл. */
function assertBudget(deadlineMs: number | null, nowMs: () => number): void {
  if (deadlineMs !== null && nowMs() > deadlineMs) {
    throw new KaitenError(BUDGET_EXHAUSTED_REASON);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateBody(text: string): string {
  return text.length > ERROR_BODY_LIMIT
    ? text.slice(0, ERROR_BODY_LIMIT)
    : text;
}

/**
 * Тело успешного ответа: пустое — отсутствие данных (`undefined`), а не
 * ошибка разбора; неразобравшееся — ошибка запроса, а не пустой
 * результат (`kaiten-http.md`, «Запрос»).
 */
function parseBody(request: KaitenRequest, text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new KaitenError(
      `kaiten ${request.method} ${request.path}: ответ не JSON`,
      { cause: err },
    );
  }
}

/** Значение — объект-запись (не массив, не `null`, не примитив). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Число как есть либо `null`: значение чужого типа полем не считается. */
export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Строка как есть либо `null` — для полей, где «нет значения» значимо. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Булево как есть либо `null` — по той же причине, что `stringOrNull`. */
export function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Строка либо запасное значение — для полей, где пустота неотличима от «нет». */
export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
