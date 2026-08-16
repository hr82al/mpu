import { assertEquals, assertRejects } from "@std/assert";
import { VerbatimError } from "../command/mod.ts";
import type { RawChat } from "./chat.ts";
import type { ChatSearch } from "./lookup.ts";
import { findChatByTitle } from "./lookup.ts";

function chat(rawId: number, title: string): RawChat {
  return { peerType: "supergroup", rawId, title, username: null };
}

/** Поиск, отвечающий заданным списком; запросы видны в `asked`. */
function search(
  found: readonly RawChat[],
): { readonly client: ChatSearch; readonly asked: [string, number][] } {
  const asked: [string, number][] = [];
  return {
    asked,
    client: {
      searchChats: (query, limit) => {
        asked.push([query, limit]);
        return Promise.resolve(found);
      },
    },
  };
}

Deno.test("ровно одно совпадение — это и есть адресат", async () => {
  const { client, asked } = search([chat(3, "Команда релиза")]);
  assertEquals(await findChatByTitle(client, "Команда релиза", "чат"), {
    id: -1000000000003,
    title: "Команда релиза",
    kind: "group",
    username: null,
  });
  // Первые 50 кандидатов — тот же предел, что у `ls` по умолчанию.
  assertEquals(asked, [["Команда релиза", 50]]);
});

Deno.test("сравнение без учёта регистра", async () => {
  const { client } = search([chat(3, "Команда Релиза")]);
  assertEquals(
    (await findChatByTitle(client, "команда релиза", "чат")).id,
    -1000000000003,
  );
});

Deno.test("точное совпадение старше подстрочных", async () => {
  const { client } = search([
    chat(1, "Команда релиза и поддержки"),
    chat(2, "Команда"),
    chat(3, "Команда разработки"),
  ]);
  assertEquals(
    (await findChatByTitle(client, "Команда", "чат")).id,
    -1000000000002,
  );
});

Deno.test("подстрочное совпадение годится, когда точного нет", async () => {
  const { client } = search([chat(2, "Команда релиза")]);
  assertEquals(
    (await findChatByTitle(client, "релиз", "чат")).id,
    -1000000000002,
  );
});

Deno.test("повторы одного чата не делают выдачу неоднозначной", async () => {
  // Контакты и глобальный каталог приходят одним ответом, и один и тот
  // же чат бывает в обоих списках.
  const { client } = search([chat(3, "Команда"), chat(3, "Команда")]);
  assertEquals(
    (await findChatByTitle(client, "Команда", "чат")).id,
    -1000000000003,
  );
});

Deno.test("несколько чатов — отказ с перечислением кандидатов", async () => {
  const { client } = search([
    chat(1, "Команда релиза"),
    chat(2, "Команда поддержки"),
  ]);
  const err = await assertRejects(
    () => findChatByTitle(client, "Команда", "чат"),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: под название 'Команда' подходит несколько чатов: " +
      "'Команда релиза' → id -1000000000001; " +
      "'Команда поддержки' → id -1000000000002; " +
      "попробуй: указать адресата по id или @username",
  );
});

Deno.test("ни одного чата — отказ с подсказкой ls", async () => {
  const { client } = search([]);
  const err = await assertRejects(
    () => findChatByTitle(client, "Команда", "чат"),
    VerbatimError,
  );
  assertEquals(
    err.message,
    "telegram: не удалось найти чат 'Команда': совпадений нет; " +
      "попробуй: mpu telegram ls 'Команда' и укажи id или @username",
  );
});

Deno.test("отказ Telegram остаётся отказом Telegram", async () => {
  const flood = Object.assign(new Error("FLOOD_WAIT"), { seconds: 42 });
  const client: ChatSearch = { searchChats: () => Promise.reject(flood) };
  const err = await assertRejects(
    () => findChatByTitle(client, "Команда", "чат"),
    VerbatimError,
  );
  // Срок ожидания не теряется и не выдаётся за ненайденный чат.
  assertEquals(err.message, "telegram: rate-limit, подожди 42s");
});

Deno.test("предмет поиска называется в отказе", async () => {
  const { client } = search([]);
  const err = await assertRejects(
    () => findChatByTitle(client, "Иван", "отправителя"),
    VerbatimError,
  );
  assertEquals(
    err.message.startsWith("telegram: не удалось найти отправителя 'Иван'"),
    true,
  );
});
