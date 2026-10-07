/**
 * Результат вызова API маркетплейса и его печать (`docs/specs/call.md`,
 * «Ввод/вывод»): текст, запись `end json` и строка журнала. Ответ здесь
 * уже замаскирован — ключа в результате нет по построению.
 */

import { z } from "zod";

/** Ответ маркетплейса: статус, заголовки квоты, тело. */
const replySchema = z.object({
  kind: z.literal("reply"),
  status: z.number().int(),
  method: z.string(),
  /** Полный адрес запроса: `https://<хост><путь>`. */
  url: z.string(),
  /** Время запроса к маркетплейсу, мс. */
  ms: z.number().int(),
  /** Только заголовки квоты, в порядке списка получателя. */
  headers: z.record(z.string(), z.string()),
  /** Разобранный JSON либо строка, если ответ не JSON. */
  body: z.json(),
  /** Байты полученного тела — для журнала. */
  bytes: z.number().int(),
});

/** `dry`: запрос, как ушёл бы, с ключом `***`. */
const drySchema = z.object({
  kind: z.literal("dry"),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  /** Тело запроса; у запроса без тела — `null`. */
  body: z.string().nullable(),
});

const callSchema = z.discriminatedUnion("kind", [replySchema, drySchema]);

/**
 * Результат команды. Корень схемы результата обязан быть объектом
 * (`platform/command-contract.md`), поэтому union лежит полем.
 */
export const resultSchema = z.object({ call: callSchema });

/** Результат команды целиком. */
export type CallOutcome = z.infer<typeof resultSchema>;
/** Результат вызова: ответ либо `dry`. */
export type CallResult = z.infer<typeof callSchema>;
/** Ответ маркетплейса. */
export type Reply = z.infer<typeof replySchema>;

/** Запись `end json`: у ответа — поля спеки в её порядке. */
export function callRecord(result: CallResult): unknown {
  if (result.kind === "dry") {
    const { method, url, headers, body } = result;
    return { method, url, headers, body };
  }
  const { status, method, url, ms, headers, body } = result;
  return { status, method, url, ms, headers, body };
}

/** Текст для человека. */
export function renderCall(result: CallResult): string {
  if (result.kind === "dry") {
    const headers = Object.entries(result.headers)
      .map(([name, value]) => `${name}: ${value}\n`).join("");
    const body = result.body === null ? "" : `\n${result.body}\n`;
    return `${result.method} ${result.url}\n${headers}${body}`;
  }
  const url = new URL(result.url);
  const headers = Object.entries(result.headers)
    .map(([name, value]) => `${name}: ${value}\n`).join("");
  // Запрос адреса — часть ручки: у WB он и называет выборку (W1).
  const address = `${url.host}${url.pathname}${url.search}`;
  return `HTTP ${result.status} ${result.method} ${address}\n` +
    `${headers}\n${bodyText(result.body)}`;
}

/** Ответил ли маркетплейс успехом: статус 2xx. */
export function succeeded(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Код выхода: маркетплейс ответил не 2xx — 1. */
export function callExitCode(result: CallResult): number {
  if (result.kind === "dry") return 0;
  return succeeded(result.status) ? 0 : 1;
}

/** Строка note журнала: статус, размер тела, заголовки квоты — без тела. */
export function journalNote(reply: Reply): string {
  const headers = Object.entries(reply.headers)
    .map(([name, value]) => `, ${name}: ${value}`).join("");
  return `HTTP ${reply.status}, тело ${reply.bytes} байт${headers}`;
}

/** Тело печатью: JSON — с отступами, строка — как есть; с переводом строки. */
function bodyText(body: z.infer<typeof replySchema>["body"]): string {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Тело ответа результатом: JSON разобранным, иначе строкой. */
export function parsedBody(text: string): z.infer<typeof replySchema>["body"] {
  try {
    return JSON.parse(text);
  } catch {
    // Не JSON — не ошибка: спека печатает такое тело как есть.
    return text;
  }
}
