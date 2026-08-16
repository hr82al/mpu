/**
 * Живой сеанс MTProto (`docs/specs/platform/telegram-mtproto.md`):
 * единственное место, знающее про клиент Telegram.
 *
 * Модуль подгружается лениво из команды: крипта MTProto и её wasm не
 * должны попадать в старт каждого вызова `mpu`. Тестами он не покрыт
 * намеренно — сеть в тестах запрещена, а всё, что можно решить без неё,
 * решено в `send.ts` и `plan.ts`; здесь остаётся склейка с протоколом.
 */

import { convertFromTelethonSession } from "@mtcute/convert";
import {
  InputMedia,
  MemoryStorage,
  proxyTransportFromUrl,
  TelegramClient,
} from "@mtcute/deno";
import { md } from "@mtcute/markdown-parser";
import { VerbatimError } from "../command/mod.ts";
import type { TelegramConfig } from "./config.ts";
import { configError, telegramFailure } from "./errors.ts";
import type { Peer } from "./peer.ts";
import { proxyUrl } from "./proxy.ts";
import type {
  ClientMessage,
  PeerRef,
  TelegramClient as CommandClient,
} from "./client.ts";

/** Открытый сеанс: клиент отправки и его закрытие. */
export interface TelegramSession extends CommandClient {
  /** Закрывает соединение; зовётся в любом исходе вызова. */
  readonly close: () => Promise<void>;
}

/**
 * Открывает сеанс: клиент в памяти, строка сессии из env-файла, прокси —
 * если задан. Хранилище только в памяти: строка сессии разделяется с
 * прежней реализацией и переписываться не должна.
 *
 * Вернувшийся сеанс уже авторизован и знает собственную учётную запись:
 * авторизация проверяется до операции, а без знания о себе не резолвится
 * адресат `me` (там же, «Инварианты» и «Резолв адресата»).
 */
export async function openSession(
  config: TelegramConfig,
): Promise<TelegramSession> {
  const client = new TelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: new MemoryStorage(),
    ...(config.proxy === undefined
      ? {}
      : { transport: proxyTransportFromUrl(proxyUrl(config.proxy)) }),
    disableUpdates: true,
  });
  await enter(client, config.session);
  return {
    resolve: async (peer: Peer) => ({
      ref: await client.resolvePeer(peerId(peer)),
    }),
    sendText: async (to, text, markdown) =>
      message(await client.sendText(inputPeer(to), body(text, markdown))),
    sendDocuments: async (to, documents, markdown) => {
      const medias = documents.map((document) =>
        InputMedia.document(document.bytes, {
          fileName: document.name,
          ...(document.caption === undefined
            ? {}
            : { caption: body(document.caption, markdown) }),
        })
      );
      const peer = inputPeer(to);
      const sent = medias.length === 1
        ? [await client.sendMedia(peer, medias[0])]
        : await client.sendMediaGroup(peer, medias);
      return sent.map(message);
    },
    close: () => client.destroy(),
  };
}

/**
 * Вход в сеанс: строка сессии, соединение и проверка авторизации. Отказ
 * на любом шаге гасит клиента — иначе после него остаются хранилище и
 * открытые ресурсы, а закрывать сеанс, которого вызывающий не получил,
 * ему нечем.
 */
async function enter(client: TelegramClient, session: string): Promise<void> {
  try {
    await importSession(client, session);
    await client.connect();
    // Отказ здесь — либо отозванная сессия (её импорт не отличает от
    // годной), либо отказ Telegram; в обоих случаях он обязан прийти до
    // операции и своим текстом, а не выдать себя за ненайденный чат.
    await client.getMe();
  } catch (err) {
    await client.destroy();
    // Отказ импорта уже оформлен слоем — переоформлять его не за что.
    throw err instanceof VerbatimError ? err : entryFailure(err);
  }
}

/**
 * Строка сессии приходит в формате прежней реализации, и клиент её как
 * есть не принимает — она переводится конвертером. Не принятая строка —
 * то же, что её отсутствие: вход не выполнен.
 */
async function importSession(
  client: TelegramClient,
  session: string,
): Promise<void> {
  try {
    await client.importSession(convertFromTelethonSession(session));
  } catch (err) {
    throw notAuthorized(err);
  }
}

/**
 * Отказ входа. Отказы авторизации Telegram называет своими кодами
 * (`AUTH_KEY_*`, `SESSION_*`, `USER_DEACTIVATED*`) — им положен текст
 * про вход, прочему — общий текст отказа протокола.
 */
function entryFailure(err: unknown): Error {
  const text = err instanceof Error && "text" in err ? String(err.text) : "";
  return /^(AUTH_KEY|SESSION_|USER_DEACTIVATED)/.test(text)
    ? notAuthorized(err)
    : telegramFailure(err);
}

function notAuthorized(cause: unknown): Error {
  return configError("не авторизован; запусти `mpu init`", { cause });
}

/** Адресат в форме, понятной клиенту. */
function peerId(peer: Peer): string | number {
  if (peer.kind === "me") return "me";
  if (peer.kind === "id") return peer.id;
  return peer.name;
}

/**
 * Разворачивает обёртку адресата. Приведение здесь безопасно и
 * единственно возможно: в `ref` кладёт значение `resolve` этого же
 * модуля — ровно то, что вернул клиент, — а тип отправки о клиенте
 * не знает и знать не должен.
 */
function inputPeer(to: PeerRef): Parameters<TelegramClient["sendText"]>[0] {
  return to.ref as Parameters<TelegramClient["sendText"]>[0];
}

/** Разметка Markdown — только по флагу; без него текст уходит как есть. */
function body(text: string, markdown: boolean): string | ReturnType<typeof md> {
  return markdown ? md(text) : text;
}

/** Сообщение клиента в форме, которую знает отправка. */
function message(sent: {
  readonly id: number;
  readonly chat: { readonly id: number };
  readonly date: Date;
}): ClientMessage {
  return { id: sent.id, chatId: sent.chat.id, date: sent.date };
}
