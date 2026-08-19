/**
 * Транспорт web-клиента 10X (`docs/specs/search.md`, «HTTP и кэш
 * токенов»): базовый URL из env-файла, заголовки, разбор обёртки ответа
 * и единая форма отказа. Ни одного вызова по имени файл не знает — их
 * перечень лежит рядом, в `./x10.ts`.
 *
 * Ниже — общий `httpSend` (`../http/mod.ts`): пределы времени и причина
 * сетевого отказа одной строкой решены там; здесь только трактовка
 * протокола 10X.
 */

import { DomainError } from "../command/mod.ts";
import { HttpCallError, httpSend } from "../http/mod.ts";

/** Дефолт базового URL, когда ни одна переменная не задана (спека). */
const DEFAULT_BASE_URL = "https://app.system10x.ru/api";

/** Ключи env-файла глазами транспорта. */
export interface EnvKeys {
  readonly get: (name: string) => string | undefined;
}

/** Один вызов 10X: метод, путь от базы, тело и токен, если они есть. */
export interface X10Request {
  readonly method: "GET" | "POST";
  /** Путь с ведущим `/`, включая query. */
  readonly path: string;
  readonly body?: unknown;
  readonly token?: string;
}

/** Отправитель запроса; подменяется в тестах — живого 10X у них нет. */
export type X10Send = (
  url: URL,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<{ readonly status: number; readonly text: string }>;

/**
 * Базовый URL 10X: `X10_URL`, затем `X10_API_URL`, затем дефолт.
 * Хвостовые `/` отрезаются, суффикс `/api` добавляется, если его нет, —
 * пользователь одинаково часто пишет и адрес приложения, и адрес API.
 */
export function x10BaseUrl(env: EnvKeys): string {
  const raw = value(env, "X10_URL") ?? value(env, "X10_API_URL") ??
    DEFAULT_BASE_URL;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

/**
 * Вызов 10X: возвращает `data` успешной обёртки `{success, message,
 * data}`. Все отказы — `DomainError` с текстом спеки; префикс `mpu
 * search:` добавляет форматирование ошибки.
 */
export async function x10Call(
  baseUrl: string,
  request: X10Request,
  send: X10Send = denoSend,
): Promise<unknown> {
  const where = `${request.method} ${request.path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (request.token !== undefined) {
    headers.authorization = `Bearer ${request.token}`;
  }
  if (request.body !== undefined) headers["content-type"] = "application/json";

  let response: { status: number; text: string };
  try {
    response = await send(new URL(`${baseUrl}${request.path}`), {
      method: request.method,
      headers,
      body: request.body === undefined
        ? undefined
        : JSON.stringify(request.body),
    });
  } catch (err) {
    const reason = err instanceof HttpCallError || err instanceof Error
      ? err.message
      : String(err);
    throw new DomainError(`${where}: transport error: ${reason}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    // Подсказку про креды к 401/403 добавляет вызывающий: она про
    // конфигурацию команды, а не про протокол (спека, отклонение `fix`).
    throw new X10StatusError(`${where}: HTTP ${response.status}`, {
      status: response.status,
    });
  }
  return unwrap(where, response.text);
}

/** Отказ 10X со статусом: по нему вызывающий узнаёт 401/403 и повтор. */
export class X10StatusError extends DomainError {
  override name = "X10StatusError";
  readonly status: number;

  constructor(message: string, options: { readonly status: number }) {
    super(message);
    this.status = options.status;
  }
}

/** `data` успешного ответа; тело не той формы — отказ с описанием. */
function unwrap(where: string, text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DomainError(`${where}: ответ не JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DomainError(`${where}: ответ не объект`);
  }
  if (!("data" in parsed)) throw new DomainError(`${where}: в ответе нет data`);
  return (parsed as { data: unknown }).data;
}

/** Отправитель по умолчанию — общий транспорт HTTP. */
async function denoSend(
  url: URL,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
): Promise<{ status: number; text: string }> {
  const response = await httpSend(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return { status: response.status, text: response.text };
}

/** Значение ключа; пустое равнозначно отсутствию (`platform/env-file.md`). */
function value(env: EnvKeys, name: string): string | undefined {
  const raw = env.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}
