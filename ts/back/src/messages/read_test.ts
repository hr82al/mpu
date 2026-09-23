import { assertEquals, assertThrows } from "@std/assert";
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
  keyword: [{
    keys: { query: "value", "seller-id": "value" },
    required: ["query", "seller-id"],
  }],
};

Deno.test({
  name: "шаг не трогает окружение, файлы и сеть и повторяется",
  permissions: "none",
  async fn() {
    const words = Object.freeze([
      "--seller-id=54",
      "--query",
      "select 1",
      END,
      "x",
    ]);
    const first = await plain(readMessage(words, SQLRO));
    const second = await plain(readMessage(words, SQLRO));
    assertEquals(first, second);
    assertEquals(first, {
      message: { keyword: { query: "select 1", "seller-id": "54" } },
      rest: [END, "x"],
    });
    assertEquals(words, ["--seller-id=54", "--query", "select 1", END, "x"]);
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
    await t.step(c.words.join(" "), async () => {
      assertEquals(await plain(readMessage(c.words, KITEN)), {
        message: c.message,
        rest: c.rest,
      });
    });
  }
});

Deno.test("правила спеки вне эталона: унарное за значением — результату", async (t) => {
  for (
    const words of [
      ["card:", "1", "--help"],
      ["card:", "1", LITERAL, "x"],
      ["card:", "1", "x"],
    ]
  ) {
    await t.step(words.join(" "), async () => {
      assertEquals(await plain(readMessage(words, KITEN)), {
        message: { keyword: { card: "1" } },
        rest: [END, ...words.slice(2)],
      });
    });
  }
});

Deno.test("правила спеки вне эталона: короткий флаг за значением", () => {
  const err = assertThrows(
    () => readMessage(["card:", "1", "-v"], KITEN),
    StrayWord,
  );
  assertEquals(err.message, "значение 1 не понимает -v");
  assertEquals([err.value, err.word, err.taken], ["1", "-v", ["card:", "1"]]);
});

Deno.test("правила спеки вне эталона: слово-не-значение", async (t) => {
  for (const words of [["card:", "--help"], ["card:", END]]) {
    await t.step(words.join(" "), () => {
      const err = assertThrows(
        () => readMessage(words, KITEN),
        MessageParseError,
      );
      assertEquals(err.message, "у ключа card нет значения");
    });
  }
});

Deno.test("у приёмника с хвостом пустая строка — всё равно справка", async () => {
  assertEquals(
    await plain(readMessage([], { unary: [], keyword: [], tail: "args" })),
    { message: { unary: "help" }, rest: [] },
  );
});

const LISTED: ReceiverDescription = {
  unary: [],
  keyword: [{
    keys: { range: "list", dry: "flag" },
    required: ["range"],
  }],
};

Deno.test("выражения значений: список, флаг, лишнее слово", async (t) => {
  await t.step("ключ-список — группа и stdin по порядку", async () => {
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
    assertEquals(await plain(readMessage(words, LISTED)), {
      message: { keyword: { range: ["«do x end»", "A1", "«stdin»"] } },
      rest: [],
    });
  });
  for (const value of [[GRAMMAR.open, "x", END], [GRAMMAR.stdin]]) {
    await t.step(`флаг: ${value.join(" ")}`, () => {
      const err = assertThrows(
        () => readMessage(["range:", "A1", "dry:", ...value], LISTED),
        MessageParseError,
      );
      assertEquals(err.message, "ключ dry ждёт true или false");
    });
  }
  await t.step("лишнее слово за группой — отказ с её текстом", () => {
    const err = assertThrows(
      () => readMessage(["card:", GRAMMAR.open, "x", END, "-v"], KITEN),
      StrayWord,
    );
    assertEquals(
      err.message,
      `значение ${GRAMMAR.open} x ${END} не понимает -v`,
    );
  });
});
