import { assertEquals } from "@std/assert";
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

Deno.test("порядок ответа сервера: сначала контакты, потом каталог", () => {
  assertEquals(chatsFromSearch(REPLY).map((chat) => chat.rawId), [1, 3, 4, 1]);
});

Deno.test("пользователь: имя склеивается, вид — user", () => {
  assertEquals(chatsFromSearch(REPLY)[0], {
    peerType: "user",
    rawId: 1,
    title: "Иван Петров",
    username: "ipetrov",
  });
});

Deno.test("канал и базовая группа различаются видом", () => {
  const [, channel, group] = chatsFromSearch(REPLY);
  assertEquals(channel.peerType, "channel");
  assertEquals(channel.title, "Канал релизов");
  assertEquals(group.peerType, "chat");
  assertEquals(group.username, null);
});

Deno.test("бот отличается от пользователя", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerUser", userId: 2 }],
    users: REPLY.users,
    chats: [],
  });
  assertEquals(found[0].peerType, "bot");
  assertEquals(found[0].title, "Бот");
});

Deno.test("супергруппа отличается от канала флагом", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerChannel", channelId: 5 }],
    users: [],
    chats: [{ _: "channel", id: 5, title: "Супергруппа", megagroup: true }],
  });
  assertEquals(found[0].peerType, "supergroup");
});

Deno.test("ссылка без объекта пропускается, а не даёт пустой чат", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerUser", userId: 404 }],
    users: [],
    chats: [],
  });
  assertEquals(found, []);
});

Deno.test("имя пользователя берётся из списка имён, если поля нет", () => {
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
  assertEquals(found[0].username, "petr");
});

Deno.test("сообщество маркируется как супергруппа, а не как чужой чат", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerChannel", channelId: 8 }],
    users: [],
    chats: [{ _: "community", id: 8, title: "Сообщество" }],
  });
  assertEquals(found[0].peerType, "supergroup");
});

Deno.test("пустые записи пропускаются, а не дают чат без данных", async (t) => {
  await t.step("chatEmpty", () => {
    assertEquals(
      chatsFromSearch({
        myResults: [],
        results: [{ _: "peerChat", chatId: 9 }],
        users: [],
        chats: [{ _: "chatEmpty", id: 9 }],
      }),
      [],
    );
  });
  await t.step("userEmpty", () => {
    assertEquals(
      chatsFromSearch({
        myResults: [],
        results: [{ _: "peerUser", userId: 10 }],
        users: [{ _: "userEmpty", id: 10 }],
        chats: [],
      }),
      [],
    );
  });
});

Deno.test("чат неизвестного вида не теряется", () => {
  const found = chatsFromSearch({
    myResults: [],
    results: [{ _: "peerChat", chatId: 7 }],
    users: [],
    chats: [{ _: "chatForbidden", id: 7, title: "Закрытая группа" }],
  });
  assertEquals(found[0].peerType, "chat");
  assertEquals(found[0].title, "Закрытая группа");
});
