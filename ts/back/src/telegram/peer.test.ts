import { assert, describe, expect, it } from "vitest";
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
  // Ведущий «+» перед цифрами объявляет телефон так же, как «@» —
  // имя: второй попытки у такой строки нет.
  { input: "+79990000000", peer: { kind: "name", name: "+79990000000" } },
  { input: "+7", peer: { kind: "name", name: "+7" } },
  // «+» без цифр телефона не объявляет: это название чата.
  { input: "+AbCdEfGh", peer: { kind: "title", title: "+AbCdEfGh" } },
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

describe("от адресата остались одни знаки объявления", () => {
  for (const input of ["@", "t.me/@", "https://t.me/@"]) {
    it(input, () => {
      let err: unknown;
      try {
        parsePeer(input);
      } catch (e) {
        err = e;
      }
      assert(
        err instanceof VerbatimUsageError,
        "ожидался отказ VerbatimUsageError",
      );
      expect(err.message).toStrictEqual(
        "telegram: адресат не задан; укажи --chat или " +
          "TELEGRAM_DEFAULT_CHAT в .env",
      );
    });
  }
});

describe("приведение адресата", () => {
  for (const { input, peer } of CASES) {
    it(input, () => expect(parsePeer(input)).toStrictEqual(peer));
  }
});
