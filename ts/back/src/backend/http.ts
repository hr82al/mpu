/**
 * Строка простым HTTP (`platform/back-http-line.md`): кадры потоком
 * NDJSON или одним собранным JSON — две доставки, выбранные по `Accept`
 * один раз, — и вопрос номером: ответ кончается кадром с номером, строка
 * ждёт продолжения следующим запросом.
 */

import type { ServerFrame } from "../frames/mod.ts";
import type { Caller } from "./caller.ts";
import type { Door } from "./door.ts";
import type { Asking, Delivery } from "./line.ts";
import type { Tickets } from "./tickets.ts";

const NDJSON_TYPE = "application/x-ndjson";
const JSON_TYPE = "application/json";

const encoder = new TextEncoder();

/** Кому сказать, что клиент ушёл, не дочитав. */
export interface Client {
  lost(): void;
}

/** Открытый ответ: куда слать кадры и что вернуть HTTP. */
export interface Opened {
  readonly delivery: Delivery;
  readonly response: Promise<Response>;
}

/** Форма ответа строки. */
export interface Form {
  open(client: Client): Opened;
}

/** Поток: кадр — строка NDJSON сразу, по мере появления. */
const NDJSON: Form = {
  open(client) {
    // `start` зовётся синхронно в конструкторе потока: к возврату из
    // `open` обе операции уже связаны с контроллером.
    let enqueue: (bytes: Uint8Array) => void = () => {};
    let close: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue = (bytes) => controller.enqueue(bytes);
        close = () => controller.close();
      },
      // Клиент оборвал поток: строка закрыта, вывод отбрасывается.
      cancel: () => client.lost(),
    });
    return {
      delivery: {
        frame: (frame) => enqueue(encoder.encode(`${JSON.stringify(frame)}\n`)),
        end: () => close(),
      },
      response: Promise.resolve(
        new Response(stream, { headers: { "Content-Type": NDJSON_TYPE } }),
      ),
    };
  },
};

/** Итог собранного ответа: `exit` или вопрос с номером. */
type Tail =
  | { readonly exit: number }
  | { readonly ask: string; readonly ticket?: string };

/**
 * Собранный ответ: копит потоки, отдаёт один объект в конце. Обрыв
 * клиентом не отслеживается: строка всё равно доходит до конца, ответ
 * просто некому отдать (`request.signal` Deno к тому же срабатывает и на
 * успешном ответе).
 */
const COLLECTED: Form = {
  open() {
    let stdout = "";
    let stderr = "";
    let tail: Tail = { exit: 1 };
    const body = Promise.withResolvers<Response>();
    // Кадр — данные границы контракта: его вид — его ключ.
    const take = (frame: ServerFrame) => {
      if ("out" in frame) stdout += frame.out;
      else if ("err" in frame) stderr += frame.err;
      else tail = frame;
    };
    return {
      delivery: {
        frame: take,
        end: () =>
          body.resolve(
            new Response(JSON.stringify({ stdout, stderr, ...tail }), {
              headers: { "Content-Type": JSON_TYPE },
            }),
          ),
      },
      response: body.promise,
    };
  },
};

/** Диапазон заголовка `Accept`: тип, подтип, вес. */
interface Range {
  readonly type: string;
  readonly subtype: string;
  readonly q: number;
}

function rangesOf(accept: string): Range[] {
  return accept.split(",").map((part) => {
    const [media, ...params] = part.split(";").map((one) => one.trim());
    const [type = "", subtype = ""] = media.toLowerCase().split("/");
    const weight = params.find((param) => param.startsWith("q="));
    const q = weight === undefined ? 1 : Number(weight.slice(2));
    return { type, subtype, q: Number.isFinite(q) ? q : 0 };
  }).filter((range) => range.type !== "");
}

/**
 * Вес типа по правилам HTTP: решает самый точный подходящий диапазон
 * (`a/b` точнее `a/*`, тот точнее `*\/*`); ни один не подошёл — 0.
 */
function weightOf(mediaType: string, ranges: readonly Range[]): number {
  const [type, subtype] = mediaType.split("/");
  const rank = (range: Range) => {
    if (range.type === type && range.subtype === subtype) return 3;
    if (range.type === type && range.subtype === "*") return 2;
    if (range.type === "*" && range.subtype === "*") return 1;
    return 0;
  };
  const best = ranges
    .filter((range) => rank(range) > 0)
    .sort((a, b) => rank(b) - rank(a))[0];
  return best === undefined ? 0 : best.q;
}

/** Формы в порядке предпочтения при равных весах. */
const FORMS: readonly (readonly [string, Form])[] = [
  [NDJSON_TYPE, NDJSON],
  [JSON_TYPE, COLLECTED],
];

/**
 * Форма ответа по заголовку `Accept`: нет заголовка — поток; из
 * допустимых — с большим весом, при равенстве — поток; ни одной — ничего
 * (406).
 */
export function formFor(accept: string | null): Form | undefined {
  if (accept === null || accept.trim() === "") return NDJSON;
  const ranges = rangesOf(accept);
  let chosen: Form | undefined;
  let top = 0;
  for (const [mediaType, form] of FORMS) {
    const weight = weightOf(mediaType, ranges);
    if (weight > top) {
      chosen = form;
      top = weight;
    }
  }
  return chosen;
}

/**
 * Вопрос номером: кадр `ask` с номером заканчивает ответ, строка ждёт
 * без доставки; номер отзывается, когда ожидание кончилось.
 */
export function ticketAsking(
  tickets: Tickets,
  door: Door,
  caller: Caller,
): Asking {
  return {
    pose(line, question) {
      const ticket = tickets.issue(line, door, caller);
      line.deliver({ ask: question, ticket: ticket.id });
      line.detach();
      return ticket;
    },
  };
}
