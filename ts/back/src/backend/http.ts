/**
 * Строка простым HTTP (`platform/back-http-line.md`): кадры потоком
 * NDJSON или одним собранным JSON — две доставки, выбранные по `Accept`
 * один раз, — и вопрос номером: ответ кончается кадром с номером, строка
 * ждёт продолжения следующим запросом.
 */

import {
  askFrame,
  type AskKind,
  type RefusalData,
  type ServerFrame,
} from "../frames/mod.ts";
import type { Caller } from "./caller.ts";
import type { Door } from "./door.ts";
import type { Asking, Delivery } from "./line.ts";
import type { Outlet } from "./outlet.ts";
import type { Tickets } from "./tickets.ts";

const NDJSON_TYPE = "application/x-ndjson";
const JSON_TYPE = "application/json";

const encoder = new TextEncoder();

/** Кому сказать, что клиент ушёл, не дочитав, и кто отдаёт вывод. */
export interface Client {
  lost(): void;
  /** Отдача итогового вывода собранного ответа (`long-output.md`, §4). */
  outlet(): Outlet;
}

/** Открытый ответ: куда слать кадры и что вернуть HTTP. */
export interface Opened {
  readonly delivery: Delivery;
  readonly response: Promise<Response>;
  /**
   * Запрос оборвался. Что это значит, решает сама форма: у потока уход
   * клиента виден его отменой, у собранного ответа — только отсюда
   * (`platform/mcp-cancel.md`).
   */
  leave(): void;
}

/** Форма ответа строки. */
export interface Form {
  open(client: Client): Opened;
}

/**
 * Готовность принять следующий кадр. Помнит, сколько места в очереди
 * потока и кто ждёт освобождения; ждущих будит сам читатель, а при его
 * уходе — тот, кто закрывает поток: иначе печатающий остался бы ждать
 * вечно и с ним встала бы остановка сервера.
 */
class Readiness {
  /** Места в очереди потока; `null` — очередь его не считает. */
  #room: number | null = 1;
  #waiting: (() => void)[] = [];

  /** Место в очереди после выдачи кадра или запроса читателя. */
  room(left: number | null) {
    this.#room = left;
  }

  /** Обещание, которое разрешится, когда клиент разберёт отданное. */
  promise(): Promise<void> {
    if (this.#room === null || this.#room > 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  /** Ждать больше нечего: отпустить всех. */
  release() {
    const waiting = this.#waiting;
    this.#waiting = [];
    // Отпускаются все разом, а не по одному на прочитанный кадр: у
    // одной команды потоков вывода не больше двух (stdout и stderr),
    // и перебор ограничен этим числом, а не размером вывода.
    for (const resume of waiting) resume();
  }
}

/** Поток: кадр — строка NDJSON сразу, по мере появления. */
const NDJSON: Form = {
  open(client) {
    const readiness = new Readiness();
    // `start` зовётся синхронно в конструкторе потока: к возврату из
    // `open` обе операции уже связаны с контроллером.
    let enqueue: (bytes: Uint8Array) => void = () => {};
    let close: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue = (bytes) => {
          controller.enqueue(bytes);
          readiness.room(controller.desiredSize);
        };
        close = () => {
          controller.close();
          readiness.release();
        };
      },
      // Читатель забрал кусок и просит ещё: отданное разобрано.
      pull(controller) {
        readiness.room(controller.desiredSize);
        readiness.release();
      },
      // Клиент оборвал поток: строка закрыта, вывод отбрасывается, а
      // ждущие отпускаются — их слушать больше некому.
      cancel: () => {
        readiness.room(1);
        readiness.release();
        client.lost();
      },
    });
    return {
      delivery: {
        frame: (frame) => enqueue(encoder.encode(`${JSON.stringify(frame)}\n`)),
        // Очередь потока набита — печатающий ждёт читателя, а не копит
        // вывод в памяти сервера (`platform/line-cancel.md`).
        ready: () => readiness.promise(),
        end: () => close(),
      },
      response: Promise.resolve(
        new Response(stream, { headers: { "Content-Type": NDJSON_TYPE } }),
      ),
      // Уход клиента поток видит своей отменой (`cancel` выше), и она
      // приходит раньше: второй раз говорить строке нечего.
      leave: () => {},
    };
  },
};

/** Итог собранного ответа: `exit` или вопрос с номером. */
type Tail =
  | { readonly exit: number }
  | {
    readonly ask: string;
    readonly kind?: AskKind;
    readonly ticket?: string;
  };

/**
 * Собранный ответ: копит потоки, отдаёт один объект в конце. Уход
 * клиента здесь не виден ни потоку (его нет), ни `request.signal`
 * самому по себе: Deno взводит сигнал и после успешно отданного ответа
 * (замер 2026-09-22, легаси-поведение). Различает их состояние самой
 * формы: ответ уже готов — сигнал опоздал и ничего не значит; ответа
 * ещё нет — клиента больше нет, и строке пора останавливаться
 * (`platform/mcp-cancel.md`).
 */
const COLLECTED: Form = {
  open(client) {
    let stdout = "";
    let stderr = "";
    let tail: Tail = { exit: 1 };
    // Отказ строки объектом (`platform/refusal-object.md`): у строки без
    // отказа поля нет вовсе.
    let refused: { readonly refusal?: RefusalData } = {};
    const body = Promise.withResolvers<Response>();
    // Кадр — данные границы контракта: его вид — его ключ.
    const take = (frame: ServerFrame) => {
      if ("out" in frame) stdout += frame.out;
      else if ("err" in frame) stderr += frame.err;
      // Просьба о буфере обмена в собранный ответ не входит: у него
      // нет клиента с терминалом, и итогом строки она не является
      // (`platform/line-prompt.md`).
      else if ("clip" in frame) stderr += frame.clip;
      else if ("refusal" in frame) refused = frame;
      // Простым HTTP ввод не запрашивается: он приходит полем тела
      // (`platform/stdin-on-request.md`).
      else if ("stdinRequest" in frame) return;
      else tail = frame;
    };
    let answered = false;
    return {
      delivery: {
        frame: take,
        // Собранный ответ копится по устройству: давления нет.
        ready: () => Promise.resolve(),
        end: () => {
          answered = true;
          body.resolve(assembled(client, stdout, stderr, refused, tail));
        },
      },
      response: body.promise,
      // Ложное срабатывание здесь опаснее пропущенного: строка,
      // объявленная отменённой после успешного ответа, дала бы запись
      // журнала кодом 130 вместо своего.
      leave: () => {
        if (answered) return;
        answered = true;
        client.lost();
        // Ответ всё равно нужен: обработчик обязан вернуть `Response`,
        // иначе запрос висит до остановки сервера. Читать его некому —
        // клиент ушёл, — поэтому тело пустое, а код говорит, что
        // случилось (499, «клиент закрыл запрос»).
        body.resolve(new Response(null, { status: 499 }));
      },
    };
  },
};

/**
 * Тело собранного ответа. Вывод итога (`exit`) отдаёт строка — целиком или
 * файлом; на вопросе строка не кончилась, и вывод идёт как есть.
 */
async function assembled(
  client: Client,
  stdout: string,
  stderr: string,
  refused: { readonly refusal?: RefusalData },
  tail: Tail,
): Promise<Response> {
  const output = "exit" in tail
    ? await client.outlet().settle(stdout)
    : { stdout };
  return new Response(
    JSON.stringify({ ...output, stderr, ...refused, ...tail }),
    { headers: { "Content-Type": JSON_TYPE } },
  );
}

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
    pose(line, question, kind) {
      const ticket = tickets.issue(line, door, caller);
      line.deliver(askFrame(question, kind, ticket.id));
      line.detach();
      return ticket;
    },
  };
}
