import { assertEquals, assertRejects } from "@std/assert";
import { DATA, origin, runChain, Shape, unary } from "./mod.ts";
import { said, testTree } from "./testtree.ts";

Deno.test({
  name: "исполнение не трогает окружение, файлы и сеть и повторяется",
  permissions: "none",
  async fn() {
    const { root } = testTree();
    const lines = [
      ["kiten", "card", "123", "show"],
      ["kitn"],
      ["version", "name"],
      ["kiten", "card", "--help"],
    ];
    const first: unknown[] = [];
    const second: unknown[] = [];
    for (const words of lines) first.push(said(await runChain(words, root)));
    for (const words of lines) second.push(said(await runChain(words, root)));
    assertEquals(first, second);
    assertEquals(first.slice(0, 3), [
      { path: ["kiten", "card", "<card>", "show"], value: { id: "123" } },
      { error: "mpu: не понимает kitn; ближайшие: kiten", code: 2 },
      {
        error: "mpu version: цепочка окончена, name отправить некому",
        code: 2,
      },
    ]);
  },
});

Deno.test("справка к методу не исполняет его", async () => {
  const { root, kiten } = testTree();
  const outcome = await runChain(["kiten", "ls", "--help"], root);
  assertEquals("value" in outcome, true);
  assertEquals(kiten.listed(), 0);
  await runChain(["kiten", "ls"], root);
  assertEquals(kiten.listed(), 1);
});

Deno.test("help и --help последним словом дают один текст", async () => {
  const { root } = testTree();
  const texts = new Set<unknown>();
  for (
    const words of [["kiten", "card", "help"], ["kiten", "card", "--help"]]
  ) {
    const outcome = await runChain(words, root);
    texts.add("value" in outcome ? outcome.value : outcome);
  }
  assertEquals(texts.size, 1);
});

Deno.test("help не последним словом — отказ с готовой строкой", async (t) => {
  const { root } = testTree();
  for (
    const [words, error] of [
      [
        ["help", "kiten", "card"],
        "mpu help: не понимает kiten; справка — последним словом: " +
        "mpu kiten card help",
      ],
      [
        ["kiten", "help", "card"],
        "mpu kiten help: не понимает card; справка — последним словом: " +
        "mpu kiten card help",
      ],
    ] as const
  ) {
    await t.step(words.join(" "), async () => {
      assertEquals(said(await runChain(words, root)), { error, code: 2 });
    });
  }
});

const DOC = { purpose: "проба", help: "Справка: проба." };

Deno.test("ключевое сообщение объекту с видом звена — непонятое", async () => {
  const { root } = testTree();
  assertEquals(said(await runChain(["kiten", "card", "nope:", "1"], root)), {
    error: "mpu kiten card: не понимает nope:",
    code: 2,
  });
});

Deno.test("ближайших не больше трёх, при равном расстоянии — по алфавиту", async () => {
  const shape = new Shape<null>(
    ["ae", "ad", "aaa", "ac", "ab"].map((s) => unary(s, DOC, DATA, () => s)),
  );
  assertEquals(said(await runChain(["a"], origin(DOC, shape, null))), {
    error: "mpu: не понимает a; ближайшие: ab, ac, ad",
    code: 2,
  });
});

Deno.test("порог ближайших — от длины селектора: короткий не цепляется", async () => {
  const shape = new Shape<null>(
    ["it", "kiten", "card", "card:"].map((s) => unary(s, DOC, DATA, () => s)),
  );
  const cases = [
    ["kitn", "mpu: не понимает kitn; ближайшие: kiten"],
    ["car", "mpu: не понимает car; ближайшие: card, card:"],
    ["itt", "mpu: не понимает itt; ближайшие: it"],
  ] as const;
  for (const [word, error] of cases) {
    assertEquals(said(await runChain([word], origin(DOC, shape, null))), {
      error,
      code: 2,
    });
  }
});

Deno.test("сбой объекта, не являющийся отказом, не превращается в отказ", async () => {
  const shape = new Shape<null>([
    unary("boom", DOC, DATA, () => {
      throw new TypeError("сломалось");
    }),
  ]);
  await assertRejects(
    () => runChain(["boom", "x"], origin(DOC, shape, null)),
    TypeError,
    "сломалось",
  );
});
