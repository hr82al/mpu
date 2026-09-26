/**
 * Контракт страницы с `mpu-back` (`specs/web.md`, `web-image.md`): обмен
 * ключа на сессию и три примитива экрана — прочитать (`/rpc`), отправить
 * строку, ответить на её вопрос. Cookie
 * `HttpOnly` страница не видит — браузер прикладывает её сам.
 */

/** Метод образа в узле снимка (`web-image.md`). */
export interface MethodImage {
  readonly author: string;
  readonly time: string;
  readonly source: string;
  /** Строка определения — текст правки метода. */
  readonly definition: string;
}

/** Узел `tree.snapshot` — поля, которые читает экран. */
export interface SnapshotNode {
  readonly path: readonly string[];
  readonly summary: string;
  /** Есть только у метода образа. */
  readonly image?: MethodImage;
}

/** Сообщение протокола: селектор, вид, назначение. */
export interface MessageLine {
  readonly selector: string;
  readonly kind: string;
  readonly purpose: string;
}

/** Ответ `tree.snapshot`. */
export interface Snapshot {
  readonly nodes: readonly SnapshotNode[];
  /** Протокол, который понимает любой объект. */
  readonly protocol: readonly MessageLine[];
}

/** Действующее решение узла (`policy.tree`). */
export interface NodeRuling {
  readonly path: readonly string[];
  readonly verdict: string;
  /** Путь правила-победителя; `null` — ни одно не совпало (ask). */
  readonly rule: string | null;
  readonly own: boolean;
}

/** Итог запроса к `back` — данные границы. */
export type Reply<T> =
  | { readonly kind: "loaded"; readonly value: T }
  | { readonly kind: "no-session" }
  | { readonly kind: "unreachable"; readonly base: string };

/** Отказ строки объектом (`platform/refusal-object.md`). */
export interface Refusal {
  readonly reason: string;
  /** Исправленная строка словами; нет — `null`. */
  readonly hint: readonly string[] | null;
  readonly text: string;
}

/** Итог строки: потоки, код и отказ, если он объектом. */
export interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
  readonly refusal?: Refusal;
}

/** Ответ строки: вопрос с номером или итог. */
export type LineReply =
  | { readonly kind: "question"; readonly ask: string; readonly ticket: string }
  | { readonly kind: "outcome"; readonly outcome: Outcome };

/** Что api берёт снаружи: `fetch` и адрес страницы. */
export interface Transport {
  readonly fetch: typeof fetch;
  /** Адрес `back` для текста «недоступен». */
  readonly base: string;
}

async function reach<T>(
  transport: Transport,
  path: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
): Promise<Reply<T>> {
  let response: Response;
  try {
    response = await transport.fetch(path, {
      ...init,
      credentials: "same-origin",
    });
  } catch {
    // Сетевой сбой — сервер не отвечает; причину покажет адрес.
    return { kind: "unreachable", base: transport.base };
  }
  if (response.status === 401) return { kind: "no-session" };
  if (!response.ok) return { kind: "unreachable", base: transport.base };
  try {
    return { kind: "loaded", value: await read(response) };
  } catch {
    // Ответ не по контракту (не JSON — например, страница прокси): для
    // экрана это тот же «back недоступен», а не вечная загрузка.
    return { kind: "unreachable", base: transport.base };
  }
}

/** Метод `/rpc` без параметров. */
export function rpc<T>(
  transport: Transport,
  method: string,
): Promise<Reply<T>> {
  return reach(transport, "/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  }, async (response) => (await response.json()).result as T);
}

/** Ключ из ссылки `mpu web` → сессия; `true` — cookie выдана. */
export async function exchangeKey(
  transport: Transport,
  key: string,
): Promise<boolean> {
  try {
    const response = await transport.fetch("/web/session", {
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ key }),
    });
    return response.status === 204;
  } catch {
    // Обмен не удался — дальше страница узнает всё по 401 или сбою.
    return false;
  }
}

function lineReply(body: Record<string, unknown>): LineReply {
  if (typeof body.ticket === "string" && typeof body.ask === "string") {
    return { kind: "question", ask: body.ask, ticket: body.ticket };
  }
  const outcome: Outcome = {
    stdout: String(body.stdout ?? ""),
    stderr: String(body.stderr ?? ""),
    exit: Number(body.exit),
    // Форма отказа — контракт `back` (`schema.json`, `refusal`).
    ...(body.refusal === undefined ? {} : { refusal: body.refusal as Refusal }),
  };
  return { kind: "outcome", outcome };
}

const JSON_ACCEPT = { Accept: "application/json" };

/** Строка экрана (`["deny:", "--", "kiten"]`, `["ask", "image", "sync"]`). */
export function sendLine(
  transport: Transport,
  words: readonly string[],
): Promise<Reply<LineReply>> {
  return reach(transport, "/line", {
    method: "POST",
    headers: JSON_ACCEPT,
    body: JSON.stringify({ words, cwd: "/", human: true }),
  }, async (response) => lineReply(await response.json()));
}

/** Ответ на вопрос строки по номеру. */
export function answer(
  transport: Transport,
  ticket: string,
  yes: boolean,
): Promise<Reply<LineReply>> {
  return reach(transport, "/line/answer", {
    method: "POST",
    headers: JSON_ACCEPT,
    body: JSON.stringify({ ticket, answer: yes ? "y" : "n" }),
  }, async (response) => lineReply(await response.json()));
}
