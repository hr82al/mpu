/**
 * Транспорт Apps Script webapp (`platform/webapp-http.md`): один POST,
 * бюджет попыток и разбор ответа.
 *
 * URL не печатается ни в данных, ни в текстах ошибок: deployment
 * публичный, и знание адреса равносильно доступу к таблицам.
 */

import { DomainError } from "../command/mod.ts";
import { firstLine, HttpCallError, httpSend } from "../http/mod.ts";

/** Предел времени одного запроса; webapp отвечает медленно. */
const TIMEOUT_MS = 120_000;

/** Бюджет попыток на вызов. */
const ATTEMPTS = 6;

/** Пауза backoff: 250 ms × 2ⁿ, потолок 8 s, плюс jitter до 25 %. */
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 8_000;

/** Пауза после отказа по квоте и после транзиентного 404. */
const QUOTA_PAUSE_MS = 60_000;
const NOT_FOUND_PAUSE_MS = 10_000;

/** Сколько подряд 404 терпится, прежде чем это станет ошибкой. */
const NOT_FOUND_RETRIES = 3;

/** Обрезка тела в текстах ошибок: короткая и длинная формы. */
const SHORT_BODY = 200;
const LONG_BODY = 500;

/** Ответ webapp глазами транспорта. */
interface RawResponse {
  readonly status: number;
  readonly text: string;
}

/** Что нужно вызову webapp сверх самого запроса. */
export interface WebappDeps {
  readonly url: string;
  /** Заметки о повторах: они идут в журнал вызовов, не на экран. */
  readonly note: (line: string) => void;
  /** Подстановки для тестов: живого webapp у них нет. */
  readonly post?: (url: string, body: string) => Promise<RawResponse>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Источник jitter'а; тест подставляет постоянное значение. */
  readonly random?: () => number;
}

/**
 * Один вызов экшена. Возвращает `result` ответа; не-объект оборачивается
 * в `{value: …}` — потребителю удобнее один вид, чем два.
 */
export async function callWebapp(
  deps: WebappDeps,
  action: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  const body = JSON.stringify({ action, ...params });
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  let notFound = 0;
  let lastError = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const last = attempt === ATTEMPTS - 1;
    let response: RawResponse;
    try {
      response = await (deps.post ?? postJson)(deps.url, body);
    } catch (err) {
      const reason = err instanceof Error
        ? firstLine(err.message)
        : String(err);
      lastError = `transport: ${reason}`;
      if (last) throw failed(action, lastError);
      deps.note(`${action}: попытка ${attempt + 1} — ${lastError}`);
      await sleep(backoffMs(attempt, deps.random ?? Math.random));
      continue;
    }
    if (response.status !== 404) notFound = 0;
    if (response.status >= 500) {
      lastError = `HTTP ${response.status}: ${cut(response.text, SHORT_BODY)}`;
      if (last) throw failed(action, lastError);
      deps.note(`${action}: попытка ${attempt + 1} — ${lastError}`);
      await sleep(backoffMs(attempt, deps.random ?? Math.random));
      continue;
    }
    if (response.status === 404) {
      notFound++;
      if (notFound > NOT_FOUND_RETRIES) {
        throw new DomainError(
          `${action}: HTTP 404: ${cut(response.text, LONG_BODY)}`,
        );
      }
      deps.note(`${action}: попытка ${attempt + 1} — HTTP 404, повтор`);
      await sleep(NOT_FOUND_PAUSE_MS);
      continue;
    }
    if (response.status === 429 || quotaText(response.text)) {
      deps.note(`${action}: попытка ${attempt + 1} — квота, пауза`);
      await sleep(QUOTA_PAUSE_MS);
      continue;
    }
    if (response.status >= 400) {
      throw new DomainError(
        `${action}: HTTP ${response.status}: ${cut(response.text, LONG_BODY)}`,
      );
    }
    const reply = parseReply(action, response.text);
    if (reply.success !== true) {
      const error = typeof reply.error === "string" ? reply.error : undefined;
      // Квота приходит и с кодом 200: у неё свой признак в теле, и
      // отличается она только тем, что вызов стоит повторить.
      if (error !== undefined && /quota/i.test(error)) {
        deps.note(`${action}: попытка ${attempt + 1} — квота, пауза`);
        await sleep(QUOTA_PAUSE_MS);
        continue;
      }
      throw new DomainError(`${action}: ${error ?? "unknown error"}`);
    }
    return resultOf(reply.result);
  }
  throw new DomainError(
    `${action}: исчерпан лимит попыток (${ATTEMPTS}). Last error: ${lastError}`,
  );
}

/** Ошибка после исчерпания бюджета транспортных попыток. */
function failed(action: string, reason: string): DomainError {
  return new DomainError(
    `${action} failed after ${ATTEMPTS} attempts: ${reason}`,
  );
}

/** Признак квоты в теле ответа: регистр не важен. */
function quotaText(text: string): boolean {
  const lowered = text.toLowerCase();
  return lowered.includes("quota exceeded") ||
    lowered.includes("too many requests");
}

/** Разбор тела: не JSON и не объект — разные тексты, оба без повтора. */
function parseReply(
  action: string,
  text: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DomainError(
      `${action}: non-JSON response: ${cut(text, SHORT_BODY)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DomainError(
      `${action}: response is not an object: ${cut(text, SHORT_BODY)}`,
    );
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/** Результат вызова; не-объект оборачивается в `{value: …}`. */
function resultOf(result: unknown): Readonly<Record<string, unknown>> {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return result as Readonly<Record<string, unknown>>;
  }
  return { value: result };
}

/** Пауза попытки: экспонента с потолком плюс случайный довесок. */
export function backoffMs(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  return Math.round(base * (1 + random() * 0.25));
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Настоящий POST: редиректы следуются транспортом (webapp отвечает 302
 * на `script.googleusercontent.com`), тело — JSON. Транспортный отказ
 * поднимается как есть: решение о повторе принимает цикл попыток.
 */
async function postJson(url: string, body: string): Promise<RawResponse> {
  const response = await httpSend(new URL(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    timeouts: { headersTimeoutMs: TIMEOUT_MS, totalTimeoutMs: TIMEOUT_MS },
  });
  return { status: response.status, text: response.text };
}
