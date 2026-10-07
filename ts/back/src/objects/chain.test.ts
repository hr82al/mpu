import { describe, expect, it } from "vitest";
import { DATA, origin, runChain, Shape, unary } from "./mod.ts";
import { said, testTree } from "./testtree.ts";

it("исполнение повторяется", async () => {
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
  expect(first).toStrictEqual(second);
  expect(first.slice(0, 3)).toStrictEqual([
    { path: ["kiten", "card", "<card>", "show"], value: { id: "123" } },
    { error: "mpu: не понимает kitn; ближайшие: kiten", code: 2 },
    {
      error: "mpu version: цепочка окончена, name отправить некому",
      code: 2,
    },
  ]);
});

it("справка к методу не исполняет его", async () => {
  const { root, kiten } = testTree();
  const outcome = await runChain(["kiten", "ls", "--help"], root);
  expect("value" in outcome).toBe(true);
  expect(kiten.listed()).toBe(0);
  await runChain(["kiten", "ls"], root);
  expect(kiten.listed()).toBe(1);
});

it("help и --help последним словом дают один текст", async () => {
  const { root } = testTree();
  const texts = new Set<unknown>();
  for (
    const words of [["kiten", "card", "help"], ["kiten", "card", "--help"]]
  ) {
    const outcome = await runChain(words, root);
    texts.add("value" in outcome ? outcome.value : outcome);
  }
  expect(texts.size).toBe(1);
});

describe("help не последним словом — отказ с готовой строкой", () => {
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
    it(words.join(" "), async () => {
      expect(said(await runChain(words, root))).toStrictEqual({
        error,
        code: 2,
      });
    });
  }
});

const DOC = { purpose: "проба", help: "Справка: проба." };

it("ключевое сообщение объекту с видом звена — непонятое", async () => {
  const { root } = testTree();
  expect(said(await runChain(["kiten", "card", "nope:", "1"], root)))
    .toStrictEqual({
      error: "mpu kiten card: не понимает nope:",
      code: 2,
    });
});

it("ближайших не больше трёх, при равном расстоянии — по алфавиту", async () => {
  const shape = new Shape<null>(
    ["ae", "ad", "aaa", "ac", "ab"].map((s) => unary(s, DOC, DATA, () => s)),
  );
  expect(said(await runChain(["a"], origin(DOC, shape, null)))).toStrictEqual({
    error: "mpu: не понимает a; ближайшие: ab, ac, ad",
    code: 2,
  });
});

it("порог ближайших — от длины селектора: короткий не цепляется", async () => {
  const shape = new Shape<null>(
    ["it", "kiten", "card", "card:"].map((s) => unary(s, DOC, DATA, () => s)),
  );
  const cases = [
    ["kitn", "mpu: не понимает kitn; ближайшие: kiten"],
    ["car", "mpu: не понимает car; ближайшие: card, card:"],
    ["itt", "mpu: не понимает itt; ближайшие: it"],
  ] as const;
  for (const [word, error] of cases) {
    expect(said(await runChain([word], origin(DOC, shape, null))))
      .toStrictEqual({
        error,
        code: 2,
      });
  }
});

it("сбой объекта, не являющийся отказом, не превращается в отказ", async () => {
  const shape = new Shape<null>([
    unary("boom", DOC, DATA, () => {
      throw new TypeError("сломалось");
    }),
  ]);
  const failure = runChain(["boom", "x"], origin(DOC, shape, null));
  await expect(failure).rejects.toThrow(TypeError);
  await expect(failure).rejects.toThrow("сломалось");
});
