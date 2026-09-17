import { assertEquals, assertThrows } from "@std/assert";
import {
  type Message,
  MessageParseError,
  readMessage,
  type ReceiverDescription,
} from "./mod.ts";

const SQLRO: ReceiverDescription = {
  unary: [],
  keyword: [{
    keys: { query: "value", "seller-id": "value" },
    required: ["query", "seller-id"],
  }],
};

Deno.test({
  name: "шаг не трогает окружение, файлы и сеть и повторяется",
  permissions: "none",
  fn() {
    const words = Object.freeze(["--seller-id=54", "--query", "select 1", "x"]);
    const first = readMessage(words, SQLRO);
    const second = readMessage(words, SQLRO);
    assertEquals(first, second);
    assertEquals(first, {
      message: { keyword: { query: "select 1", "seller-id": "54" } },
      rest: ["x"],
    });
    assertEquals(words, ["--seller-id=54", "--query", "select 1", "x"]);
  },
});

const KITEN: ReceiverDescription = {
  unary: ["card"],
  keyword: [{ keys: { card: "value" }, required: ["card"] }],
};

Deno.test("правила спеки вне эталона: один шаг", async (t) => {
  const cases: readonly {
    readonly words: readonly string[];
    readonly message: Message;
    readonly rest: readonly string[];
  }[] = [
    {
      words: ["nope:", "1", "--zzz", "2", "x"],
      message: { keyword: { nope: "1", zzz: "2" } },
      rest: ["x"],
    },
    { words: ["--", "--help"], message: { unary: "--help" }, rest: [] },
    { words: ["--", "."], message: { unary: "." }, rest: [] },
    { words: ["--", "--"], message: { unary: "--" }, rest: [] },
    { words: ["--", "x"], message: { unary: "x" }, rest: [] },
    {
      words: ["card:", "1", ".", "--help"],
      message: { keyword: { card: "1" } },
      rest: ["--help"],
    },
    {
      words: ["card:", "1", ".", "--", "x"],
      message: { keyword: { card: "1" } },
      rest: ["--", "x"],
    },
    {
      words: ["card:", "1", ".", "x"],
      message: { keyword: { card: "1" } },
      rest: ["x"],
    },
  ];
  for (const c of cases) {
    await t.step(c.words.join(" "), () => {
      assertEquals(readMessage(c.words, KITEN), {
        message: c.message,
        rest: c.rest,
      });
    });
  }
});

Deno.test("правила спеки вне эталона: слово-не-значение", async (t) => {
  for (const words of [["card:", "--help"], ["card:", "."]]) {
    await t.step(words.join(" "), () => {
      const err = assertThrows(
        () => readMessage(words, KITEN),
        MessageParseError,
      );
      assertEquals(err.message, "у ключа card нет значения");
    });
  }
});
