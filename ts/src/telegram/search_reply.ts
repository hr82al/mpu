/**
 * Ответ серверного поиска чатов в форме, которую понимают команды
 * (`docs/specs/telegram-ls.md`).
 *
 * Поиск по контактам и глобальному каталогу приходит одним ответом, но
 * разложенным: списки ссылок отдельно, объекты чатов и пользователей
 * отдельно. Сборка — здесь, чтобы её проверял тест: в `session.ts`, где
 * живёт протокол, тестов нет.
 */

import type { PeerType, RawChat } from "./chat.ts";

/** Ссылка на чат в ответе поиска. */
export type PeerRefTl =
  | { readonly _: "peerUser"; readonly userId: number }
  | { readonly _: "peerChat"; readonly chatId: number }
  | { readonly _: "peerChannel"; readonly channelId: number };

/** Пользователь в ответе поиска: только нужные поля. */
export interface UserTl {
  /** Тип протокола: `userEmpty` несёт только id и в выдачу не идёт. */
  readonly _?: string;
  readonly id: number;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly username?: string;
  readonly usernames?: readonly { readonly username: string }[];
  readonly bot?: boolean;
}

/** Чат или канал в ответе поиска: только нужные поля. */
export interface ChatTl {
  readonly _: string;
  readonly id: number;
  readonly title?: string;
  readonly username?: string;
  readonly usernames?: readonly { readonly username: string }[];
  /** Канал вещания; супергруппа — `megagroup`. */
  readonly broadcast?: boolean;
  readonly megagroup?: boolean;
}

/** Ответ поиска: ссылки в порядке сервера и объекты к ним. */
export interface SearchReply {
  /** Персонализированные результаты — контакты; идут первыми. */
  readonly myResults: readonly PeerRefTl[];
  readonly results: readonly PeerRefTl[];
  readonly users: readonly UserTl[];
  readonly chats: readonly ChatTl[];
}

/**
 * Чаты в порядке выдачи сервера: сначала контакты, затем каталог.
 * Повторы не убираются — дедуп делает вызывающий, ему же принадлежит
 * решение, по чему дедуплицировать.
 */
export function chatsFromSearch(reply: SearchReply): readonly RawChat[] {
  const users = new Map(reply.users.map((user) => [user.id, user]));
  const chats = new Map(reply.chats.map((chat) => [chat.id, chat]));
  const out: RawChat[] = [];
  for (const ref of [...reply.myResults, ...reply.results]) {
    // Ссылка без объекта — неполный ответ сервера: пустой чат в выдаче
    // хуже отсутствия, id из него всё равно нечем дополнить.
    const chat = ref._ === "peerUser"
      ? userChat(users.get(ref.userId))
      : chatChat(chats.get(ref._ === "peerChat" ? ref.chatId : ref.channelId));
    if (chat !== undefined) out.push(chat);
  }
  return out;
}

function userChat(user: UserTl | undefined): RawChat | undefined {
  if (user === undefined || user._ === "userEmpty") return undefined;
  return {
    peerType: user.bot === true ? "bot" : "user",
    rawId: user.id,
    title: [user.firstName, user.lastName].filter((part) =>
      part !== undefined && part !== ""
    ).join(" "),
    username: username(user),
  };
}

function chatChat(chat: ChatTl | undefined): RawChat | undefined {
  // Пустая запись несёт один id: чат из неё не собрать, а положительный
  // id неизвестного вида читался бы как пользователь.
  if (chat === undefined || chat._ === "chatEmpty") return undefined;
  return {
    peerType: chatPeerType(chat),
    rawId: chat.id,
    title: chat.title ?? "",
    username: username(chat),
  };
}

/**
 * Вид чата по сырым полям протокола. Базовая группа и супергруппа
 * приходят разными типами, канал и супергруппа — одним, и различает их
 * флаг. Читается именно сырое представление: у обёрток библиотеки вид
 * бывает неопределим, и тогда они бросают — на списке диалогов это
 * уронило бы весь вызов из-за одной недоступной записи.
 */
export function chatPeerType(chat: ChatTl): PeerType {
  if (chat._ === "chat" || chat._ === "chatForbidden") return "chat";
  // Сообщества — те же каналы протокола, и маркируются так же; вид
  // «unknown» здесь недопустим: он оставил бы id без маркировки, а
  // положительный id читается как пользователь.
  if (chat.megagroup === true) return "supergroup";
  return chat.broadcast === true ? "channel" : "supergroup";
}

/**
 * Имя пользователя без «@»: основное поле, иначе первое из списка
 * дополнительных имён.
 */
function username(
  peer: {
    readonly username?: string;
    readonly usernames?: readonly {
      readonly username: string;
    }[];
  },
): string | null {
  if (peer.username !== undefined && peer.username !== "") return peer.username;
  return peer.usernames?.[0]?.username ?? null;
}
