import { describe, expect, it } from "vitest";
import { chatsFromSearch, type SearchReply } from "./search_reply.ts";

const REPLY: SearchReply = {
  myResults: [{ _: "peerUser", userId: 1 }],
  results: [
    { _: "peerChannel", channelId: 3 },
    { _: "peerChat", chatId: 4 },
    // Тот же чат вторым списком: ссылка есть, объект один.
    { _: "peerUser", userId: 1 },
  ],
  users: [
    { id: 1, firstName: "Иван", lastName: "Петров", username: "ipetrov" },
    { id: 2, firstName: "Бот", username: "build_bot", bot: true },
  ],
  chats: [
    { _: "channel", id: 3, title: "Канал релизов", broadcast: true },
    { _: "chat", id: 4, title: "Базовая группа" },
  ],
};

it("порядок ответа сервера: сначала контакты, потом каталог", () => {
  expect(chatsFromSearch(REPLY).map((chat) => chat.rawId)).toStrictEqual([
    1,
    3,
    4,
    1,
  ]);
});

it("пользователь: имя склеивается, вид — user", () => {
  expect(chatsFromSearch(REPLY)[0]).toStrictEqual({
    peerType: "user",
    rawId: 1,
    title: "Иван Петров",
    username: "ipetrov",
  });
});

it("канал и базовая группа различаются видом", () => {
  const [, channel, group] = chatsFromSearch(REPLY);
  expect(channel.peerType).toBe("channel");
  expect(channel.title).toBe("Канал релизов");
  expect(group.peerType).toBe("chat");
  expect(group.username).toStrictEqual(null);
});

it("бот отличается от пользователя", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerUser", userId: 2 }],
    users: REPLY.users,
    chats: [],
  });
  expect(found[0].peerType).toBe("bot");
  expect(found[0].title).toBe("Бот");
});

it("супергруппа отличается от канала флагом", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerChannel", channelId: 5 }],
    users: [],
    chats: [{ _: "channel", id: 5, title: "Супергруппа", megagroup: true }],
  });
  expect(found[0].peerType).toBe("supergroup");
});

it("ссылка без объекта пропускается, а не даёт пустой чат", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerUser", userId: 404 }],
    users: [],
    chats: [],
  });
  expect(found).toStrictEqual([]);
});

it("имя пользователя берётся из списка имён, если поля нет", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerUser", userId: 6 }],
    users: [{
      id: 6,
      firstName: "Пётр",
      usernames: [{ username: "petr" }],
    }],
    chats: [],
  });
  expect(found[0].username).toBe("petr");
});

it("сообщество маркируется как супергруппа, а не как чужой чат", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerChannel", channelId: 8 }],
    users: [],
    chats: [{ _: "community", id: 8, title: "Сообщество" }],
  });
  expect(found[0].peerType).toBe("supergroup");
});

describe("пустые записи пропускаются, а не дают чат без данных", () => {
  it("chatEmpty", () => {
    expect(chatsFromSearch({
      myResults: [],
      results: [{ _: "peerChat", chatId: 9 }],
      users: [],
      chats: [{ _: "chatEmpty", id: 9 }],
    })).toStrictEqual([]);
  });
  it("userEmpty", () => {
    expect(chatsFromSearch({
      myResults: [],
      results: [{ _: "peerUser", userId: 10 }],
      users: [{ _: "userEmpty", id: 10 }],
      chats: [],
    })).toStrictEqual([]);
  });
});

it("чат неизвестного вида не теряется", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerChat", chatId: 7 }],
    users: [],
    chats: [{ _: "chatForbidden", id: 7, title: "Закрытая группа" }],
  });
  expect(found[0].peerType).toBe("chat");
  expect(found[0].title).toBe("Закрытая группа");
});
