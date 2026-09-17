import { assertEquals, assertRejects } from "@std/assert";
import { DATA, origin, type Outcome, runChain, Shape, unary } from "./mod.ts";
import { testTree } from "./testtree.ts";

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
    const first: Outcome[] = [];
    const second: Outcome[] = [];
    for (const words of lines) first.push(await runChain(words, root));
    for (const words of lines) second.push(await runChain(words, root));
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

Deno.test("три записи справки дают один текст", async () => {
  const { root } = testTree();
  const texts = new Set<unknown>();
  for (
    const words of [
      ["help", "kiten", "card"],
      ["kiten", "help", "card"],
      ["kiten", "card", "--help"],
    ]
  ) {
    const outcome = await runChain(words, root);
    texts.add("value" in outcome ? outcome.value : outcome);
  }
  assertEquals(texts.size, 1);
});

const DOC = { purpose: "проба", help: "Справка: проба." };

Deno.test("ключевое сообщение объекту с видом звена — непонятое", async () => {
  const { root } = testTree();
  assertEquals(await runChain(["kiten", "card", "nope:", "1"], root), {
    error: "mpu kiten card: не понимает nope:",
    code: 2,
  });
});

Deno.test("ближайших не больше трёх, при равном расстоянии — по алфавиту", async () => {
  const shape = new Shape<null>(
    ["ae", "ad", "aaa", "ac", "ab"].map((s) => unary(s, DOC, DATA, () => s)),
  );
  assertEquals(await runChain(["a"], origin(DOC, shape, null)), {
    error: "mpu: не понимает a; ближайшие: ab, ac, ad",
    code: 2,
  });
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
