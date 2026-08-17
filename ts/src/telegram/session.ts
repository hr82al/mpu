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
import type { Chat, Message, User } from "@mtcute/deno";
import { md } from "@mtcute/markdown-parser";
import { VerbatimError } from "../command/mod.ts";
import { markedId, type RawChat } from "./chat.ts";
import type { TelegramConfig } from "./config.ts";
import { configError, telegramFailure } from "./errors.ts";
import type { ResolvablePeer } from "./peer.ts";
import { proxyUrl } from "./proxy.ts";
import type { RawMessage } from "./message.ts";
import { chatPeerType, chatsFromSearch } from "./search_reply.ts";
import type { SearchClient } from "./search.ts";
import type {
  ClientMessage,
  PeerRef,
  TelegramClient as CommandClient,
} from "./client.ts";

/** Открытый сеанс: клиент отправки и поиска и его закрытие. */
export interface TelegramSession extends CommandClient, SearchClient {
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
  const self = await enter(client, config.session);
  return {
    resolve: async (peer: ResolvablePeer) => {
      const ref = await client.resolvePeer(peerId(peer));
      return { ref, id: refId(ref, self) };
    },
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
    listDialogs: async (limit) => {
      const found: RawChat[] = [];
      for await (const dialog of client.iterDialogs({ limit })) {
        found.push(peerChat(dialog.peer));
      }
      return found;
    },
    searchChats: async (query, limit) =>
      chatsFromSearch(
        await client.call({ _: "contacts.search", q: query, limit }),
      ),
    // Страницы гоняет итератор клиента: разовый вызов поиска отдаёт одну
    // страницу, и `--limit` больше неё молча недобирал бы выдачу.
    searchInChat: async ({ chat, query, from, limit }) => {
      const found: RawMessage[] = [];
      for await (
        const message of client.iterSearchMessages({
          chatId: inputPeer(chat),
          query,
          limit,
          ...(from === null ? {} : { fromUser: inputPeer(from) }),
        })
      ) {
        found.push(rawMessage(message));
      }
      return found;
    },
    searchGlobal: async function* (query: string) {
      for await (const found of client.iterSearchGlobal({ query })) {
        yield rawMessage(found);
      }
    },
    close: () => client.destroy(),
  };
}

/**
 * Вход в сеанс: строка сессии, соединение и проверка авторизации. Отказ
 * на любом шаге гасит клиента — иначе после него остаются хранилище и
 * открытые ресурсы, а закрывать сеанс, которого вызывающий не получил,
 * ему нечем.
 *
 * Возвращает собственный идентификатор: адресата `me` клиент опознаёт
 * ссылкой без идентификатора, а команде он нужен числом.
 */
async function enter(client: TelegramClient, session: string): Promise<number> {
  try {
    await importSession(client, session);
    await client.connect();
    // Отказ здесь — либо отозванная сессия (её импорт не отличает от
    // годной), либо отказ Telegram; в обоих случаях он обязан прийти до
    // операции и своим текстом, а не выдать себя за ненайденный чат.
    return (await client.getMe()).id;
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

/**
 * Адресат в форме, понятной клиенту. Названия чата здесь не бывает:
 * его резолвит поиском `send.ts` — Telegram по названию не резолвит.
 */
function peerId(peer: ResolvablePeer): string | number {
  switch (peer.kind) {
    case "me":
      return "me";
    case "id":
      return peer.id;
    case "name":
      return peer.name;
    default: {
      const never: never = peer;
      throw new TypeError(`адресат не резолвится напрямую: ${String(never)}`);
    }
  }
}

/**
 * Чат из собеседника диалога. Сырой идентификатор берётся до
 * маркировки: накладывает её команда (`chat.ts`), и наложить дважды
 * значило бы напечатать чужой чат.
 */
function peerChat(peer: User | Chat): RawChat {
  if (peer.type === "user") {
    return {
      peerType: peer.isBot ? "bot" : "user",
      rawId: peer.id,
      title: peer.displayName,
      username: peer.username,
    };
  }
  return {
    peerType: chatPeerType(peer.raw),
    rawId: peer.raw.id,
    title: peer.title,
    username: peer.username,
  };
}

/**
 * Маркированный id опознанного адресата. Собственный чат клиент
 * возвращает ссылкой без идентификатора, поэтому его подставляет сеанс:
 * он узнал себя при входе.
 */
function refId(ref: { readonly _: string }, self: number): number {
  if (ref._ === "inputPeerSelf") return self;
  if ("userId" in ref) return Number(ref.userId);
  if ("chatId" in ref) return markedId("chat", Number(ref.chatId));
  if ("channelId" in ref) return markedId("channel", Number(ref.channelId));
  throw configError(`Telegram вернул адресата без идентификатора: ${ref._}`);
}

/**
 * Сообщение в форме, которую знает поиск. Ссылку строит команда
 * (`message.ts`): у клиента она бросает исключение на чатах без
 * публичных ссылок — на первой же личной переписке в выдаче.
 */
function rawMessage(found: Message): RawMessage {
  return {
    id: found.id,
    chat: peerChat(found.chat),
    sender: sender(found),
    date: found.date,
    text: found.text,
  };
}

/**
 * Отправитель сообщения. Автора нет только у анонимного админа и у
 * поста от имени канала: клиент подставляет вместо него чат. В личной
 * переписке автор отдельным полем не приходит, но известен — им и
 * остаётся собеседник.
 */
function sender(found: Message): RawChat | null {
  const raw = found.raw;
  if (!raw.fromId && raw.peerId._ !== "peerUser") return null;
  return peerChat(found.sender);
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
