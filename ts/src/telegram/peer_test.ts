import { assertEquals, assertThrows } from "@std/assert";
import { VerbatimUsageError } from "../command/mod.ts";
import { parsePeer, type Peer } from "./peer.ts";

const CASES: readonly { readonly input: string; readonly peer: Peer }[] = [
  { input: "me", peer: { kind: "me" } },
  { input: "@durov", peer: { kind: "name", name: "durov" } },
  // Голая строка, похожая на имя: имени может не быть, а чат с таким
  // названием — быть, поэтому у неё две попытки.
  { input: "durov", peer: { kind: "guess", name: "durov" } },
  { input: "news", peer: { kind: "guess", name: "news" } },
  { input: "https://t.me/durov", peer: { kind: "name", name: "durov" } },
  { input: "http://t.me/durov/", peer: { kind: "name", name: "durov" } },
  { input: "t.me/durov", peer: { kind: "name", name: "durov" } },
  { input: "t.me/@durov", peer: { kind: "name", name: "durov" } },
  { input: "12345", peer: { kind: "id", id: 12345 } },
  { input: "-1001000000001", peer: { kind: "id", id: -1001000000001 } },
  { input: "https://t.me/12345", peer: { kind: "id", id: 12345 } },
  // Телефон тоже идёт с двумя попытками: спека выносит в исключение
  // только объявленный вид («@», ссылка t.me), а не телефон.
  { input: "+79990000000", peer: { kind: "guess", name: "+79990000000" } },
  // Строка, которую Telegram сам не резолвит, — название чата: её
  // ищут поиском (`telegram-ls.md`, «Резолв по названию»).
  { input: "Команда релиза", peer: { kind: "title", title: "Команда релиза" } },
  { input: "команда", peer: { kind: "title", title: "команда" } },
  { input: "ab", peer: { kind: "title", title: "ab" } },
  // Ведущий «@» и ссылка объявляют пользователя: их резолвит сам
  // Telegram, даже если хвост не похож на обычное имя.
  { input: "@abc", peer: { kind: "name", name: "abc" } },
  {
    input: "https://t.me/+AbCdEfGh",
    peer: { kind: "name", name: "+AbCdEfGh" },
  },
  {
    input: "@Команда релиза",
    peer: { kind: "name", name: "Команда релиза" },
  },
  // Хвоста после «t.me» нет — строка берётся целиком, а не превращается
  // в пустого адресата.
  { input: "t.me/", peer: { kind: "title", title: "t.me/" } },
  // Цифр больше, чем помещается в безопасное целое: id из такой строки
  // не собрать без округления, поэтому она идёт именем.
  {
    input: "9999999999999999999",
    peer: { kind: "title", title: "9999999999999999999" },
  },
];

Deno.test("от адресата остались одни знаки объявления", async (t) => {
  for (const input of ["@", "t.me/@", "https://t.me/@"]) {
    await t.step(input, () => {
      const err = assertThrows(() => parsePeer(input), VerbatimUsageError);
      assertEquals(
        err.message,
        "telegram: адресат не задан; укажи --chat или " +
          "TELEGRAM_DEFAULT_CHAT в .env",
      );
    });
  }
});

Deno.test("приведение адресата", async (t) => {
  for (const { input, peer } of CASES) {
    await t.step(input, () => assertEquals(parsePeer(input), peer));
  }
});
