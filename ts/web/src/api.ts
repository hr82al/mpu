/**
 * Контракт страницы с `mpu-back` (`specs/web.md`): обмен ключа на сессию,
 * запросы `/rpc`, строка изменения правила с вопросом и номером. Cookie
 * `HttpOnly` страница не видит — браузер прикладывает её сам.
 */

/** Узел `tree.snapshot` (`fixtures/back-rpc/schema.json`, `treeNode`). */
export interface SnapshotNode {
  readonly path: readonly string[];
  readonly summary: string;
  readonly selectors: readonly string[];
  readonly tail: string | null;
  readonly summaries: Readonly<Record<string, string>>;
  readonly flags: readonly {
    readonly name: string;
    readonly summary: string;
  }[];
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

/** Итог строки изменения: вопрос с номером или конец строки. */
export type LineResult =
  | { readonly ask: string; readonly ticket: string }
  | { readonly exit: number; readonly stderr: string };

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

/** Ключ из ссылки `mpu-next web` → сессия; `true` — cookie выдана. */
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

function lineResult(body: Record<string, unknown>): LineResult {
  if (typeof body.ticket === "string" && typeof body.ask === "string") {
    return { ask: body.ask, ticket: body.ticket };
  }
  return { exit: Number(body.exit), stderr: String(body.stderr ?? "") };
}

const JSON_ACCEPT = { Accept: "application/json" };

/** Строка изменения правила (`["deny:", "kiten"]`). */
export function changeRule(
  transport: Transport,
  words: readonly string[],
): Promise<Reply<LineResult>> {
  return reach(transport, "/line", {
    method: "POST",
    headers: JSON_ACCEPT,
    body: JSON.stringify({ words, cwd: "/", human: true }),
  }, async (response) => lineResult(await response.json()));
}

/** Ответ на вопрос строки по номеру. */
export function answer(
  transport: Transport,
  ticket: string,
  yes: boolean,
): Promise<Reply<LineResult>> {
  return reach(transport, "/line/answer", {
    method: "POST",
    headers: JSON_ACCEPT,
    body: JSON.stringify({ ticket, answer: yes ? "y" : "n" }),
  }, async (response) => lineResult(await response.json()));
}
