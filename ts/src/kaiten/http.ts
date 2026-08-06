/**
 * Транспорт Kaiten API (`docs/specs/platform/kaiten-http.md`): доступ
 * (базовый URL и токен), форма запроса, retry на 429, формат ошибки
 * не-2xx, разбор тела ответа. Ни одного вызова по имени этот файл не
 * знает — перечни вызовов лежат в каталогах внешней границы
 * (`platform/kaiten-api-*.md`).
 *
 * Ниже транспорта — общий `httpGet` (`../http/mod.ts`): пределы времени
 * одного вызова и причина сетевого отказа одной строкой там уже решены;
 * здесь — только трактовка протокола Kaiten.
 *
 * Файл вынесен из `src/init/`: это платформенный атом, а не часть
 * команды init, и у него появляются другие потребители — каталоги
 * внешнего API.
 */

import { HttpCallError, httpGet, type RequestTimeouts } from "../http/mod.ts";

/** Дефолт `KITEN_BASE_URL`, когда переменная не задана (`kaiten-http.md`). */
const DEFAULT_BASE_URL = "https://btlz.kaiten.ru";
/** Единственный автоповторяемый статус — 429, до 6 попыток на запрос. */
const MAX_ATTEMPTS = 6;
/** База и потолок экспоненциального backoff, когда `Retry-After` не пришёл. */
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_CAP_MS = 30_000;
/** Тело ошибки не-2xx обрезается до 300 символов (`kaiten-http.md`). */
const ERROR_BODY_LIMIT = 300;
/** Причина пропуска доски при исчерпании бюджета шага (`init.md`, шаг 4). */
const BUDGET_EXHAUSTED_REASON = "бюджет шага исчерпан";

/** Подключение к Kaiten API. */
export interface KaitenAccess {
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** Сбой обращения к Kaiten; сообщение — «<причина>» одной строкой. */
export class KaitenError extends Error {
  override name = "KaitenError";
}

/** Подключение из env-файла; нет KITEN_API_KEY — KaitenError («KITEN_API_KEY не задан»). */
export function requireKaitenAccess(
  envFile: { readonly get: (name: string) => string | undefined },
): KaitenAccess {
  const apiKey = envFile.get("KITEN_API_KEY");
  if (apiKey === undefined || apiKey === "") {
    throw new KaitenError("KITEN_API_KEY не задан");
  }
  const rawUrl = envFile.get("KITEN_BASE_URL") ?? DEFAULT_BASE_URL;
  // Хвостовые `/` срезаются той же нормализацией, что у `requirePortainerAccess`
  // (`../init/cmd_init.ts`) и `requireLokiAccess` (`../loki/mod.ts`): путь
  // строится конкатенацией `baseUrl + "/api/latest" + path`, лишний `/` сложил
  // бы двойной слэш в адресе.
  return { baseUrl: rawUrl.replace(/\/+$/, ""), apiKey };
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

/**
 * Один Kaiten GET с retry на 429 (до `MAX_ATTEMPTS` попыток) и учётом
 * бюджета шага. `deadlineMs === null` — вызов без бюджета (части 1 и 4
 * прогрева); иначе — предел, после которого ни сам запрос, ни пауза retry
 * не выполняются (`init.md`, шаг 4: «перед выдачей запроса и перед каждой
 * паузой retry проверяется `nowMs() > deadline`»).
 *
 * `notes` — накопитель строк повтора, переданный вызывающим (а не
 * возвращённый вместе с результатом): при исчерпании попыток или
 * срабатывании бюджета функция бросает исключение, и строки о уже
 * прошедших паузах retry обязаны остаться видны потребителю несмотря на
 * это — через возврат только на успехе они терялись бы вместе с
 * отклонённым промисом (см. `./warmup.ts`).
 */
export async function kaitenGet(
  access: KaitenAccess,
  path: string,
  timeouts: RequestTimeouts,
  deadlineMs: number | null,
  nowMs: () => number,
  notes: string[],
): Promise<readonly unknown[]> {
  const url = new URL(`${access.baseUrl}/api/latest${path}`);
  const headers = {
    Authorization: `Bearer ${access.apiKey}`,
    Accept: "application/json",
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    assertBudget(deadlineMs, nowMs);

    let response;
    try {
      response = await httpGet(url, { headers, timeouts });
    } catch (err) {
      // `httpGet` бросает только `HttpCallError` — сообщение уже одной
      // строкой (её собственный инвариант, `../http/mod.ts`), поэтому
      // переносится как есть, без повторного прогона через `firstLine`.
      if (!(err instanceof HttpCallError)) throw err;
      throw new KaitenError(err.message, { cause: err });
    }

    if (response.status >= 200 && response.status < 300) {
      return parseItems(path, response.text);
    }

    if (response.status === 429) {
      if (attempt === MAX_ATTEMPTS) {
        throw new KaitenError(`kaiten GET ${path} -> 429: exhausted retries`);
      }
      assertBudget(deadlineMs, nowMs);
      const delayMs = retryDelayMs(attempt, response.retryAfter);
      notes.push(`[kaiten] 429 rate-limit, sleep ${delayMs / 1000}s`);
      await sleep(delayMs);
      continue;
    }

    throw new KaitenError(
      `kaiten GET ${path} -> ${response.status}: ${
        truncateBody(response.text)
      }`,
    );
  }
  // Недостижимо: цикл на каждой итерации либо возвращает, либо бросает —
  // но `for` не даёт компилятору это увидеть, а без завершающего throw
  // функция не проходит проверку «не все пути возвращают значение».
  throw new KaitenError(`kaiten GET ${path} -> 429: exhausted retries`);
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
 * Тело успешного ответа как список сырых элементов. И тело, не
 * разобравшееся как JSON, и валидный JSON не той формы (не-массив там,
 * где контракт ждёт массив) — одинаково ошибка запроса, а не пустой
 * список (`kaiten-http.md`, «Запрос»): иначе испорченный ответ молча
 * заменил бы справочник пустым, и пустой справочник от испорченного
 * ответа было бы не отличить. Отличие от Loki, где пустой результат на
 * неожиданную форму — явное требование его спеки.
 *
 * Пустое тело — отсутствие данных, а не ошибка разбора (там же).
 */
function parseItems(path: string, text: string): readonly unknown[] {
  if (text.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new KaitenError(`kaiten GET ${path}: ответ не JSON`, { cause: err });
  }
  if (!Array.isArray(parsed)) {
    throw new KaitenError(`kaiten GET ${path}: ответ не JSON-массив`);
  }
  return parsed;
}

/** Значение — объект-запись (не массив, не `null`, не примитив). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Число как есть либо `null` — элементы без числового id пропускаются. */
export function numericId(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
