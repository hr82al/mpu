import { expect, it } from "vitest";
import { tl } from "@mtcute/node";
import { rejected } from "@mpu/testing/thrown";
import { VerbatimError } from "../command/mod.ts";
import { clientRefusal } from "./client_refusal.ts";
import type { RawChat } from "./chat.ts";
import type { ChatSearch } from "./lookup.ts";
import { findChatByTitle } from "./lookup.ts";

function chat(rawId: number, title: string): RawChat {
  return { peerType: "supergroup", rawId, title, username: null };
}

/** Поиск, отвечающий заданным списком; запросы видны в `asked`. */
function search(found: readonly RawChat[]): {
  readonly client: ChatSearch;
  readonly asked: [string, number][];
} {
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

it("ровно одно совпадение — это и есть адресат", async () => {
  const { client, asked } = search([chat(3, "Команда релиза")]);
  expect(await findChatByTitle(client, "Команда релиза", "чат")).toStrictEqual({
    id: -1000000000003,
    title: "Команда релиза",
    kind: "group",
    username: null,
  });
  // Первые 50 кандидатов — тот же предел, что у `ls` по умолчанию.
  expect(asked).toStrictEqual([["Команда релиза", 50]]);
});

it("сравнение без учёта регистра", async () => {
  const { client } = search([chat(3, "Команда Релиза")]);
  expect(
    (await findChatByTitle(client, "команда релиза", "чат")).id,
  ).toStrictEqual(-1000000000003);
});

it("точное совпадение старше подстрочных", async () => {
  const { client } = search([
    chat(1, "Команда релиза и поддержки"),
    chat(2, "Команда"),
    chat(3, "Команда разработки"),
  ]);
  expect((await findChatByTitle(client, "Команда", "чат")).id).toStrictEqual(
    -1000000000002,
  );
});

it("подстрочное совпадение годится, когда точного нет", async () => {
  const { client } = search([chat(2, "Команда релиза")]);
  expect((await findChatByTitle(client, "релиз", "чат")).id).toStrictEqual(
    -1000000000002,
  );
});

it("повторы одного чата не делают выдачу неоднозначной", async () => {
  // Контакты и глобальный каталог приходят одним ответом, и один и тот
  // же чат бывает в обоих списках.
  const { client } = search([chat(3, "Команда"), chat(3, "Команда")]);
  expect((await findChatByTitle(client, "Команда", "чат")).id).toStrictEqual(
    -1000000000003,
  );
});

it("несколько чатов — отказ с перечислением кандидатов", async () => {
  const { client } = search([
    chat(1, "Команда релиза"),
    chat(2, "Команда поддержки"),
  ]);
  const err = await rejected(
    () => findChatByTitle(client, "Команда", "чат"),
    VerbatimError,
  );
  expect(err.message).toStrictEqual(
    "telegram: под название 'Команда' подходит несколько чатов: " +
      "'Команда релиза' → id -1000000000001; " +
      "'Команда поддержки' → id -1000000000002; " +
      "попробуй: указать адресата по id или @username",
  );
});

it("ни одного чата — отказ с подсказкой ls", async () => {
  const { client } = search([]);
  const err = await rejected(
    () => findChatByTitle(client, "Команда", "чат"),
    VerbatimError,
  );
  expect(err.message).toStrictEqual(
    "telegram: не удалось найти чат 'Команда': совпадений нет; " +
      "попробуй: mpu telegram ls 'Команда' и укажи id или @username",
  );
});

it("отказ Telegram остаётся отказом Telegram", async () => {
  // Двойник поиска стоит выше порта сеанса и отдаёт отказ в его форме.
  const flood = clientRefusal(
    tl.RpcError.fromTl({ errorCode: 420, errorMessage: "FLOOD_WAIT_42" }),
  );
  const client: ChatSearch = { searchChats: () => Promise.reject(flood) };
  const err = await rejected(
    () => findChatByTitle(client, "Команда", "чат"),
    VerbatimError,
  );
  // Срок ожидания не теряется и не выдаётся за ненайденный чат.
  expect(err.message).toStrictEqual("telegram: rate-limit, подожди 42s");
});

it("дефект поиска — тот же объект, не отказ Telegram и не «не найден»", async () => {
  const defect = new TypeError("дефект поиска");
  const client: ChatSearch = { searchChats: () => Promise.reject(defect) };
  const err = await rejected(
    () => findChatByTitle(client, "Команда", "чат"),
    Error,
  );
  expect(err).toBe(defect);
});

it("предмет поиска называется в отказе", async () => {
  const { client } = search([]);
  const err = await rejected(
    () => findChatByTitle(client, "Иван", "отправителя"),
    VerbatimError,
  );
  expect(
    err.message.startsWith("telegram: не удалось найти отправителя 'Иван'"),
  ).toStrictEqual(true);
});
