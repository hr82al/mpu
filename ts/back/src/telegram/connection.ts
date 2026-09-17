/**
 * Соединение клиента Telegram и первый ответ после него — под пределами
 * времени (`docs/specs/platform/telegram-mtproto.md`, «Прокси»). Клиент на
 * отказ соединения и на его срыв переподключается без конца, и без предела
 * вызов через MCP-службу не ответил бы никогда.
 *
 * Отказ по пределу клиента не гасит — это делает вызывающий, закрывая
 * клиента на любом отказе: после отказа попыток соединения и таймеров от
 * вызова не остаётся (там же).
 */

import type { ConnectionState, TelegramClient } from "@mtcute/deno";
import type { VerbatimError } from "../command/mod.ts";
import { firstLine } from "../http/mod.ts";
import { configError } from "./errors.ts";

/** Предел соединения с узлом Telegram по спеке — 20 с. */
const CONNECT_LIMIT_MS = 20_000;

/** Предел первого ответа сеанса (`getMe`) по спеке — 20 с. */
export const SESSION_ANSWER_LIMIT_MS = 20_000;

/**
 * Предел первого ответа входа по спеке — 60 с: цепочка до вопроса кода
 * включает смену DC и встроенное ожидание flood-wait клиента.
 */
export const LOGIN_ANSWER_LIMIT_MS = 60_000;

/** Клиент, у которого нужны только соединение и события. */
type LimitedClient = Pick<
  TelegramClient,
  "connect" | "onConnectionState" | "onError"
>;

/**
 * Соединяет клиента и ждёт, пока соединение с узлом установится: сокет
 * открыт, напрямую или через прокси. Первый ответ после этого ограничивает
 * `answeredWithin`. Не дождался за предел — отказ `telegram: нет соединения
 * с Telegram за 20 с: <первая строка причины>`, причина — последний отказ
 * соединения.
 *
 * `client.connect()` сокета не ждёт: он только запускает соединение, а
 * открытие сокета приходит событием `connected`. Поэтому ожидается событие,
 * а не промис. Гонка здесь не оставляет ничего без владельца: проигравший —
 * либо снятый таймер, либо обещание события, которое больше никто не
 * держит; само соединение гасит вызывающий, закрывая клиента на отказе.
 */
export async function connectWithin(client: LimitedClient): Promise<void> {
  const errors = watchErrors(client);
  const usable = Promise.withResolvers<"connected">();
  const noteState = (state: ConnectionState) => {
    if (state === "connected") usable.resolve("connected");
  };
  const limit = startLimit(CONNECT_LIMIT_MS);
  client.onConnectionState.add(noteState);
  try {
    await client.connect();
    if (await Promise.race([usable.promise, limit.expired]) === "connected") {
      return;
    }
  } finally {
    limit.stop();
    client.onConnectionState.remove(noteState);
    errors.stop();
  }
  throw limitFailure("нет соединения с", CONNECT_LIMIT_MS, errors.last());
}

/**
 * Исполняет операцию, требуя первого ответа Telegram за предел. Ответ —
 * завершение операции либо вызов `answered`: им операция говорит, что ответ
 * пришёл и дальше она ждёт человека (код, пароль), а это ожидание под предел
 * не попадает. Не дождался за `limitMs` — отказ `telegram: нет ответа от
 * Telegram за <предел> с: <первая строка причины>`.
 *
 * Операция, проигравшая пределу, остаётся ждать; её отказ, который придёт,
 * когда вызывающий закроет клиента, обработан подпиской `Promise.race` и
 * наружу не всплывает. Операция зовётся внутри `try`: и синхронный её бросок
 * снимает таймер и подписку.
 */
export async function answeredWithin<T>(
  client: Pick<LimitedClient, "onError">,
  limitMs: number,
  operation: (answered: () => void) => Promise<T>,
): Promise<T> {
  const errors = watchErrors(client);
  const limit = startLimit(limitMs);
  try {
    const first = await Promise.race([
      operation(limit.stop).then((value) => ({ value })),
      limit.expired,
    ]);
    if (first !== "expired") return first.value;
  } finally {
    limit.stop();
    errors.stop();
  }
  throw limitFailure("нет ответа от", limitMs, errors.last());
}

/** Таймер предела: `expired` разрешается по сроку, если его не сняли. */
function startLimit(ms: number): {
  readonly expired: Promise<"expired">;
  readonly stop: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), ms);
  });
  return { expired, stop: () => clearTimeout(timer) };
}

/**
 * Подписка на ошибки клиента на время ожидания. Нужна дважды: из неё
 * берётся причина отказа, и без слушателя библиотека печатает каждую
 * ошибку строкой `unhandled error`.
 */
function watchErrors(client: Pick<LimitedClient, "onError">): {
  readonly last: () => Error | undefined;
  readonly stop: () => void;
} {
  let last: Error | undefined;
  const note = (err: Error) => {
    last = err;
  };
  client.onError.add(note);
  return { last: () => last, stop: () => client.onError.remove(note) };
}

/**
 * Текст отказа по пределу. Ошибок за срок не было вовсе — попытка не
 * завершилась ни успехом, ни отказом, и причина — «узел не ответил».
 */
function limitFailure(
  what: "нет соединения с" | "нет ответа от",
  ms: number,
  last: Error | undefined,
): VerbatimError {
  const reason = last === undefined
    ? "узел не ответил"
    : firstLine(last.message);
  return configError(`${what} Telegram за ${ms / 1000} с: ${reason}`, {
    cause: last,
  });
}
