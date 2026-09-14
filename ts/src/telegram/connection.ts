/**
 * Соединение клиента Telegram под пределом времени
 * (`docs/specs/platform/telegram-mtproto.md`, «Прокси»). Клиент на любой
 * отказ соединения переподключается без конца, и без предела вызов через
 * MCP-службу не ответил бы никогда.
 */

import type { ConnectionState, TelegramClient } from "@mtcute/deno";
import { firstLine } from "../http/mod.ts";
import { configError } from "./errors.ts";

/** Предел соединения с узлом Telegram по спеке — 20 с. */
const CONNECT_LIMIT_MS = 20_000;

/**
 * Соединяет клиента и ждёт, пока соединение с узлом установится: сокет
 * открыт, напрямую или через прокси. Обмен ключами и запросы после этого
 * пределом не ограничены. Не дождался за предел — отказ `telegram: нет соединения с Telegram за
 * 20 с: <первая строка причины>`, причина — последний отказ соединения.
 *
 * `client.connect()` сокета не ждёт: он только запускает соединение, а
 * открытие сокета приходит событием `connected`. Поэтому ожидается событие, а
 * не промис. Гонка здесь не оставляет ничего без владельца: проигравший —
 * либо снятый таймер, либо обещание события, которое больше никто не
 * держит; само соединение гасит вызывающий, закрывая клиента на отказе.
 *
 * Подписка на ошибки клиента на время соединения нужна дважды: из неё
 * берётся причина, и без слушателя библиотека печатает каждую ошибку
 * строкой `unhandled error`.
 */
export async function connectWithin(client: TelegramClient): Promise<void> {
  let lastRefusal: Error | undefined;
  const noteRefusal = (err: Error) => {
    lastRefusal = err;
  };
  const usable = Promise.withResolvers<"connected">();
  const noteState = (state: ConnectionState) => {
    if (state === "connected") usable.resolve("connected");
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), CONNECT_LIMIT_MS);
  });
  client.onError.add(noteRefusal);
  client.onConnectionState.add(noteState);
  try {
    await client.connect();
    if (await Promise.race([usable.promise, expired]) === "connected") return;
  } finally {
    clearTimeout(timer);
    client.onConnectionState.remove(noteState);
    client.onError.remove(noteRefusal);
  }
  // Отказов не было вовсе: попытка соединения не завершилась ни успехом,
  // ни отказом.
  const reason = lastRefusal === undefined
    ? "узел не ответил"
    : firstLine(lastRefusal.message);
  throw configError(
    `нет соединения с Telegram за ${CONNECT_LIMIT_MS / 1000} с: ${reason}`,
    { cause: lastRefusal },
  );
}
