/**
 * Отправка запроса к маркетплейсу (`docs/specs/call.md`, «Побочные
 * эффекты»): ровно один запрос, без повторов, с пределом ожидания; ответ —
 * статус, заголовки квоты и тело как пришло. Подписывает запрос ключ
 * кабинета, отправляет — `Wire`.
 */

import { DomainError } from "../command/mod.ts";
import type { Method } from "./reads.ts";
import type { Reply } from "./reply.ts";

/** Сеть и часы — переданной ссылкой. */
export interface Net {
  readonly fetch: (request: Request) => Promise<Response>;
  /** Сигнал, срабатывающий через `ms` миллисекунд. */
  readonly deadline: (ms: number) => AbortSignal;
  /** Монотонные миллисекунды — для `ms` результата. */
  readonly now: () => number;
}

/** Запрос, как он уходит: с ключом — поэтому наружу не отдаётся. */
export interface Signed {
  readonly method: Method;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

/** Ответ до маскирования: `text` — тело как пришло. */
export type Received = Omit<Reply, "body"> & { readonly text: string };

/** Отправить подписанный запрос: пределы, сеть и маска уже внутри. */
export type Wire = (request: Signed) => Promise<Received>;

/** Как отправлять: пределы, внешнее и что прятать в тексте сбоя. */
export interface Sending {
  readonly seconds: number;
  /** Просьба остановиться от вызывающего строку. */
  readonly stop: AbortSignal;
  readonly net: Net;
  readonly quotaHeaders: readonly string[];
  /** Маска ключа: текст сбоя сети может повторить заголовки запроса. */
  readonly mask: (text: string) => string;
}

/**
 * Ровно один запрос, без повторов ни на 429, ни на 5xx (спека,
 * «Побочные эффекты»): ответ маркетплейса и есть результат.
 */
export async function send(
  request: Signed,
  sending: Sending,
): Promise<Received> {
  const { seconds, stop, net } = sending;
  const deadline = net.deadline(seconds * 1000);
  const started = net.now();
  try {
    const response = await net.fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.any([deadline, stop]),
      }),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      kind: "reply",
      status: response.status,
      method: request.method,
      url: request.url,
      ms: Math.round(net.now() - started),
      headers: quotaOf(response.headers, sending.quotaHeaders),
      text: new TextDecoder().decode(bytes),
      bytes: bytes.byteLength,
    };
  } catch (err) {
    if (deadline.aborted) throw new DomainError(`нет ответа за ${seconds} с`);
    if (stop.aborted) throw err;
    // Причина — только замаскированным текстом, без `cause`: исходная
    // ошибка может нести ключ, и дальше по цепочке её не сторожит никто.
    const reason = err instanceof Error ? err.message : String(err);
    throw new DomainError(`запрос не выполнен — ${sending.mask(reason)}`);
  }
}

/** Присланные заголовки квоты — в порядке списка получателя. */
function quotaOf(
  headers: Headers,
  names: readonly string[],
): Record<string, string> {
  const quota: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) quota[name] = value;
  }
  return quota;
}
