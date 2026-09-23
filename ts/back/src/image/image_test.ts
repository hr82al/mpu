/**
 * Файл образа (`platform/image.md`, «Хранение»): нет файла — пусто и не
 * создаётся; запись — сразу; чужая запись видна следующему чтению; мусор —
 * отказ «образ: …».
 */

import { assertEquals, assertThrows } from "@std/assert";
import { Image, ImageError, ImageMethod } from "./mod.ts";

async function withDir(body: (file: string) => void | Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await body(`${dir}/state/image.db`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const CARDS_IN = new ImageMethod({
  receiver: ["kiten"],
  name: "cardsIn:",
  words: [
    "do",
    ":column",
    "kiten",
    "ls",
    "where:",
    "column",
    "is:",
    "@column",
    "done",
  ],
  purpose: "мои в колонке",
  keys: "",
  author: "human",
  time: "2026-09-23T10:00:00.000Z",
});

function names(image: Image): string[] {
  return image.methods().map((method) => method.links().join(" "));
}

Deno.test("нет файла — образ пуст, файл не создаётся", () =>
  withDir((file) => {
    using image = Image.at(file);
    assertEquals(image.methods(), []);
    assertThrows(() => Deno.statSync(file), Deno.errors.NotFound);
  }));

Deno.test("define: — запись сразу видна, файл создан", () =>
  withDir((file) => {
    using image = Image.at(file);
    image.define(CARDS_IN);
    assertEquals(names(image), ["kiten cardsIn:"]);
    using again = Image.at(file);
    const [method] = again.methods();
    assertEquals(method.snapshot(), {
      author: "human",
      time: "2026-09-23T10:00:00.000Z",
      source: "do :column kiten ls where: column is: @column done",
    });
    assertEquals(method.source().source, CARDS_IN.source().source);
  }));

Deno.test("define: того же имени заменяет метод", () =>
  withDir((file) => {
    using image = Image.at(file);
    image.define(CARDS_IN);
    image.define(
      new ImageMethod({
        ...CARDS_IN.record(),
        purpose: "другое",
        author: "agent",
      }),
    );
    const [method] = image.methods();
    assertEquals(image.methods().length, 1);
    assertEquals(method.purposeLine(), "образ: другое");
  }));

Deno.test("forget: убирает метод; нет метода — false", () =>
  withDir((file) => {
    using image = Image.at(file);
    image.define(CARDS_IN);
    assertEquals(image.forget(["kiten"], "cardsIn:"), true);
    assertEquals(image.methods(), []);
    assertEquals(image.forget(["kiten"], "cardsIn:"), false);
  }));

Deno.test("метод другого процесса виден следующему чтению (data_version)", () =>
  withDir((file) => {
    using first = Image.at(file);
    first.define(CARDS_IN);
    assertEquals(names(first), ["kiten cardsIn:"]);
    using second = Image.at(file);
    second.define(new ImageMethod({ ...CARDS_IN.record(), name: "mine" }));
    assertEquals(names(first), ["kiten cardsIn:", "kiten mine"]);
    second.forget(["kiten"], "cardsIn:");
    assertEquals(names(first), ["kiten mine"]);
  }));

Deno.test("файл появился после открытия — виден следующему чтению", () =>
  withDir((file) => {
    using first = Image.at(file);
    assertEquals(first.methods(), []);
    using second = Image.at(file);
    second.define(CARDS_IN);
    assertEquals(names(first), ["kiten cardsIn:"]);
  }));

Deno.test("мусор вместо файла — отказ «образ: …»", () =>
  withDir(async (file) => {
    await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(
      file,
      "это не база данных, а просто текст ".repeat(40),
    );
    using image = Image.at(file);
    const err = assertThrows(() => image.methods(), ImageError);
    assertEquals(err.message.startsWith("образ: "), true);
  }));

Deno.test("нет каталога состояния — пусто; запись — отказ", () => {
  using image = Image.at(undefined);
  assertEquals(image.methods(), []);
  assertThrows(
    () => image.define(CARDS_IN),
    ImageError,
    "образ: каталог состояния не задан (нет HOME)",
  );
});

Deno.test("метод: части имени, селектор вида, хэш исходника", () => {
  const two = new ImageMethod({ ...CARDS_IN.record(), name: "top:by:" });
  assertEquals(two.parts(), ["top:", "by:"]);
  assertEquals(two.selector(), "by:top:");
  assertEquals(two.links(), ["kiten", "top:by:"]);
  const unary = new ImageMethod({ ...CARDS_IN.record(), name: "mine" });
  assertEquals(unary.parts(), []);
  assertEquals(unary.selector(), "mine");
  // printf '%s' 'do :column kiten ls where: column is: @column done' | sha256sum
  assertEquals(
    CARDS_IN.hash(),
    "18a567aa75dff7782309620a91664dd1a4c91f0edec1b39c24b625cd448a89c2",
  );
});
