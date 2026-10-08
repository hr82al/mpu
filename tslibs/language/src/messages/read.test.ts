import { describe, expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import {
  type Evaluation,
  GRAMMAR,
  type Message,
  MessageParseError,
  type MessageStep,
  readMessage,
  type ReceiverDescription,
  resolvedMessage,
  StrayWord,
} from "./mod.ts";

const { close: END, literal: LITERAL } = GRAMMAR;

/** Выражения значений видны метками: группа — «do … end», ввод — «stdin». */
const SHOWN: Evaluation = {
  group: (words) =>
    Promise.resolve(`«${[GRAMMAR.open, ...words, GRAMMAR.close].join(" ")}»`),
  stdin: () => Promise.resolve(`«${GRAMMAR.stdin}»`),
};

/** Шаг разбора с вычисленными значениями — данными. */
async function plain(step: MessageStep) {
  return {
    message: await resolvedMessage(step.message, SHOWN),
    rest: step.rest,
  };
}

const SQLRO: ReceiverDescription = {
  unary: [],
  keyword: [
    {
      keys: { query: "value", "seller-id": "value" },
      required: ["query", "seller-id"],
    },
  ],
};

it("шаг повторяется", async () => {
  const words = Object.freeze([
    "--seller-id=54",
    "--query",
    "select 1",
    END,
    "x",
  ]);
  const first = await plain(readMessage(words, SQLRO));
  const second = await plain(readMessage(words, SQLRO));
  expect(first).toStrictEqual(second);
  expect(first).toStrictEqual({
    message: { keyword: { query: "select 1", "seller-id": "54" } },
    rest: [END, "x"],
  });
  expect(words).toStrictEqual([
    "--seller-id=54",
    "--query",
    "select 1",
    END,
    "x",
  ]);
});

const KITEN: ReceiverDescription = {
  unary: ["card"],
  keyword: [{ keys: { card: "value" }, required: ["card"] }],
};

describe("правила спеки вне эталона: один шаг", () => {
  const cases: readonly {
    readonly words: readonly string[];
    readonly message: Message;
    readonly rest: readonly string[];
  }[] = [
    {
      words: ["nope:", "1", "--zzz", "2", END, "x"],
      message: { keyword: { nope: "1", zzz: "2" } },
      rest: [END, "x"],
    },
    { words: [LITERAL, "--help"], message: { unary: "--help" }, rest: [] },
    { words: [LITERAL, "."], message: { unary: "." }, rest: [] },
    { words: [LITERAL, LITERAL], message: { unary: LITERAL }, rest: [] },
    { words: [LITERAL, "x"], message: { unary: "x" }, rest: [] },
    { words: ["card:", "."], message: { keyword: { card: "." } }, rest: [] },
    {
      words: ["card:", "1", END, "--help"],
      message: { keyword: { card: "1" } },
      rest: [END, "--help"],
    },
  ];
  for (const c of cases) {
    it(c.words.join(" "), async () => {
      expect(await plain(readMessage(c.words, KITEN))).toStrictEqual({
        message: c.message,
        rest: c.rest,
      });
    });
  }
});

describe("правила спеки вне эталона: унарное за значением — результату", () => {
  for (const words of [
    ["card:", "1", "--help"],
    ["card:", "1", LITERAL, "x"],
    ["card:", "1", "x"],
  ]) {
    it(words.join(" "), async () => {
      expect(await plain(readMessage(words, KITEN))).toStrictEqual({
        message: { keyword: { card: "1" } },
        rest: [END, ...words.slice(2)],
      });
    });
  }
});

it("правила спеки вне эталона: короткий флаг за значением", () => {
  const err = thrown(() => readMessage(["card:", "1", "-v"], KITEN), StrayWord);
  expect(err.message).toBe("значение 1 не понимает -v");
  expect([err.value, err.word, err.taken]).toStrictEqual([
    "1",
    "-v",
    ["card:", "1"],
  ]);
});

describe("правила спеки вне эталона: слово-не-значение", () => {
  for (const words of [
    ["card:", "--help"],
    ["card:", END],
  ]) {
    it(words.join(" "), () => {
      const err = thrown(() => readMessage(words, KITEN), MessageParseError);
      expect(err.message).toBe("у ключа card нет значения");
    });
  }
});

it("у приёмника с хвостом пустая строка — всё равно справка", async () => {
  expect(
    await plain(readMessage([], { unary: [], keyword: [], tail: "args" })),
  ).toStrictEqual({ message: { unary: "help" }, rest: [] });
});

const LISTED: ReceiverDescription = {
  unary: [],
  keyword: [
    {
      keys: { range: "list", dry: "flag" },
      required: ["range"],
    },
  ],
};

describe("выражения значений: список, флаг, лишнее слово", () => {
  it("ключ-список — группа и stdin по порядку", async () => {
    const words = [
      "range:",
      GRAMMAR.open,
      "x",
      END,
      "range:",
      "A1",
      "range:",
      GRAMMAR.stdin,
    ];
    expect(await plain(readMessage(words, LISTED))).toStrictEqual({
      message: { keyword: { range: ["«do x end»", "A1", "«stdin»"] } },
      rest: [],
    });
  });
  for (const value of [[GRAMMAR.open, "x", END], [GRAMMAR.stdin]]) {
    it(`флаг: ${value.join(" ")}`, () => {
      const err = thrown(
        () => readMessage(["range:", "A1", "dry:", ...value], LISTED),
        MessageParseError,
      );
      expect(err.message).toBe("ключ dry ждёт true или false");
    });
  }
  for (const [value, text] of [
    [["dry:", "true"], "true"],
    [["range:", GRAMMAR.stdin], GRAMMAR.stdin],
  ]) {
    it(`лишнее слово за ${text} — отказ с ним`, () => {
      const err = thrown(
        () => readMessage(["range:", "A1", ...value, "-v"], LISTED),
        StrayWord,
      );
      expect(err.message).toStrictEqual(`значение ${text} не понимает -v`);
    });
  }
  it("лишнее слово за группой — отказ с её текстом", () => {
    const err = thrown(
      () => readMessage(["card:", GRAMMAR.open, "x", END, "-v"], KITEN),
      StrayWord,
    );
    expect(err.message).toStrictEqual(
      `значение ${GRAMMAR.open} x ${END} не понимает -v`,
    );
  });
});

const SEND: ReceiverDescription = {
  unary: [],
  keyword: [
    {
      keys: { text: "value", chat: "value", to: "list", id: "value" },
      required: [],
      texts: ["text", "chat", "to"],
    },
    { keys: { text: "value", id: "value" }, required: [], texts: ["text"] },
  ],
};

describe("ключ-текст берёт слово как есть (`platform/at-word-literal.md`)", () => {
  const cases: readonly {
    readonly words: readonly string[];
    readonly message: Message;
  }[] = [
    {
      words: [
        "chat:",
        "@kalabass",
        "text:",
        "@kalabass Иван, итог: всё готово.",
      ],
      message: {
        keyword: {
          chat: "@kalabass",
          text: "@kalabass Иван, итог: всё готово.",
        },
      },
    },
    { words: ["text:", "."], message: { keyword: { text: "." } } },
    { words: ["text:", END], message: { keyword: { text: END } } },
    {
      words: ["text:", "rem"],
      message: { keyword: { text: "rem" } },
    },
    { words: ["text:", "--help"], message: { keyword: { text: "--help" } } },
    { words: ["text:", LITERAL, END], message: { keyword: { text: END } } },
    {
      words: ["text:", GRAMMAR.stdin],
      message: { keyword: { text: "«stdin»" } },
    },
    {
      words: ["text:", GRAMMAR.open, "kiten", "ls", END],
      message: { keyword: { text: "«do kiten ls end»" } },
    },
    {
      words: ["to:", "@all", "to:", "@ivan"],
      message: { keyword: { to: ["@all", "@ivan"] } },
    },
    { words: ["--text", "@all"], message: { keyword: { text: "@all" } } },
  ];
  for (const one of cases) {
    it(one.words.join(" "), async () => {
      const step = await plain(readMessage(one.words, SEND));
      expect(step).toStrictEqual({ message: one.message, rest: [] });
    });
  }
});

it("ключ-текст: ключ на месте значения — нет значения, как прежде", () => {
  thrown(
    () => readMessage(["text:", "chat:", "me"], SEND),
    MessageParseError,
    "у ключа text нет значения",
  );
});
