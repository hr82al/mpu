/**
 * Один HTTP-вызов sl-back (`platform/slback-http.md`, «Запрос», «Ответ
 * и ошибки»): сборка URL, заголовки, единственная попытка под общим
 * пределом времени и разбор ответа.
 *
 * Отказ здесь называет себя сам и несёт сохранённое тело ответа: класс
 * ошибки (доменная или ввода) и её префикс — дело команды, а не
 * транспорта (`api.md`).
 */

import { httpSend } from "../http/mod.ts";

/**
 * Предел всего вызова. Один, а не пара «заголовки/всё»: спека атома
 * называет ровно одно число, и предел заголовков уже 30 s дал бы отказ
 * там, где спека его не обещает (тот же вывод, что у `src/gitlab/`).
 */
export const SLBACK_TIMEOUT_MS = 30_000;

/** Сколько байт тела ответа попадает в текст отказа HTTP ≥ 400. */
export const ERROR_BODY_LIMIT = 500;
/** Сколько — в текст отказа «ответ не JSON» и «нет accessToken». */
export const RESPONSE_LIMIT = 200;

/**
 * Отказ вызова sl-back: текст спеки плюс сохранённое тело ответа.
 * Тело — отдельным полем, а не частью текста: команда печатает его
 * следующей строкой, а не внутри строки ошибки (`api.md`, «Ввод/вывод»).
 */
export class SlbackError extends Error {
  override name = "SlbackError";
  /** Код ответа; у транспортного сбоя его нет. */
  readonly status: number | undefined;
  /** Тело ответа, уже обрезанное; печатать нечего — пустая строка. */
  readonly body: string;

  constructor(
    message: string,
    opts: { status?: number; body?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.status = opts.status;
    this.body = opts.body ?? "";
  }
}

/**
 * Обрезка длинного текста с маркером спеки. Обе величины — байты:
 * прежняя реализация перехватывает ответ байтовыми кусками, бюджет у
 * неё в байтах, и `dropped` копится там же в байтах. Считать предел в
 * символах значило бы разойтись с ней вдвое на любом кириллическом
 * теле.
 *
 * Граница ставится по символам, а не по байтам: обрезать посреди
 * многобайтового символа значит напечатать символ-заменитель вместо
 * буквы. Из-за этого граница бывает на два-три байта левее предела —
 * расхождение видно только на теле, чей разрез пришёлся ровно на
 * середину символа.
 */
export function truncate(text: string, limit: number): string {
  const encoder = new TextEncoder();
  const total = encoder.encode(text).length;
  if (total <= limit) return text;
  let kept = 0;
  let head = "";
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (kept + size > limit) break;
    kept += size;
    head += char;
  }
  return `${head}…(+${total - kept} bytes)`;
}

/** Что нужно знать вызову сверх адреса. */
export interface SlbackCall {
  readonly method: string;
  /** Путь запроса; ведущий `/` добавляется, если его нет. */
  readonly path: string;
  /** Тело; не задано — запрос уходит без тела и без Content-Type. */
  readonly body?: unknown;
  /** Bearer-токен; не задан — единственный неавторизованный вызов. */
  readonly token?: string;
}

/**
 * Вызов и разбор ответа. Пустое тело 2xx — «нет данных» (`undefined`),
 * а не ошибка; любой другой JSON отдаётся как есть, включая массив,
 * строку и `null`.
 */
export async function slbackCall(
  baseUrl: string,
  call: SlbackCall,
): Promise<unknown> {
  const path = call.path.startsWith("/") ? call.path : `/${call.path}`;
  const where = `${call.method} ${path}`;
  const headers: Record<string, string> = {};
  if (call.token !== undefined) {
    headers["authorization"] = `Bearer ${call.token}`;
  }
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  if (body !== undefined) headers["content-type"] = "application/json";

  let response;
  try {
    response = await httpSend(new URL(`${baseUrl}${path}`), {
      method: call.method,
      headers,
      body,
      timeouts: {
        headersTimeoutMs: SLBACK_TIMEOUT_MS,
        totalTimeoutMs: SLBACK_TIMEOUT_MS,
      },
    });
  } catch (err) {
    throw new SlbackError(
      `${where} failed: transport error: ${reasonOf(err)}`,
      { cause: err },
    );
  }

  if (response.status >= 400) {
    throw new SlbackError(`${where} failed: HTTP ${response.status}`, {
      status: response.status,
      body: truncate(response.text, ERROR_BODY_LIMIT),
    });
  }
  if (response.text === "") return undefined;
  try {
    return parseJsonVerbatim(response.text);
  } catch (err) {
    throw new SlbackError(
      `${where}: non-JSON response: ${truncate(response.text, RESPONSE_LIMIT)}`,
      { cause: err },
    );
  }
}

/**
 * Разбор JSON, сохраняющий числа дословно. Обычный `JSON.parse`
 * переводит их в double, и обратная печать расходится с ответом
 * сервера: `1.0` печатается как `1`, а целое больше 2^53 теряет
 * точность **молча** — идентификатор в ответе становится соседним
 * числом. Обёртка `JSON.rawJSON` возвращает в вывод ровно те символы,
 * что пришли: печать становится побайтно верной ответу, а не своей
 * версией его чисел.
 *
 * Значение внутри обёртки остаётся тем же JSON: `JSON.stringify`
 * подставляет исходный текст, поэтому ни рендер, ни структурный
 * результат о ней не знают.
 */
export function parseJsonVerbatim(text: string): unknown {
  return json.parse(text, (_key, value, context) => {
    // Источник доступен только у примитивов; у объектов и массивов его
    // нет, и трогать их незачем.
    const source = context?.source;
    return typeof value === "number" && source !== undefined
      ? json.rawJSON(source)
      : value;
  });
}

/**
 * Две возможности JSON, которых ещё нет в типах стандартной
 * библиотеки: доступ разборщика к исходному тексту значения и обёртка
 * «печатать эти символы как есть». В рантайме (V8) обе есть — проверено
 * при написании; объявление здесь описывает то, что уже работает, а не
 * добавляет поведение.
 */
interface JsonWithSource {
  readonly parse: (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { readonly source?: string },
    ) => unknown,
  ) => unknown;
  readonly rawJSON: (text: string) => unknown;
}

const json = JSON as unknown as JsonWithSource;

/** Причина отказа одной строкой: у ошибок fetch бывает вторая строка. */
function reasonOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0];
}
