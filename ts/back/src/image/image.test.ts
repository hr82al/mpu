/**
 * Файл образа (`platform/image.md`, «Хранение»): нет файла — пусто и не
 * создаётся; запись — сразу; чужая запись видна следующему чтению; мусор —
 * отказ «образ: …».
 */

import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { thrown } from "@mpu/testing/thrown";
import { Image, ImageError, ImageMethod } from "./mod.ts";

async function withDir(body: (file: string) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await body(`${dir}/state/image.db`);
  } finally {
    await rm(dir, { recursive: true });
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

it("нет файла — образ пуст, файл не создаётся", () =>
  withDir((file) => {
    using image = Image.at(file);
    expect(image.methods()).toStrictEqual([]);
    expect(() => statSync(file)).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  }));

it("define: — запись сразу видна, файл создан", () =>
  withDir((file) => {
    using image = Image.at(file);
    image.define(CARDS_IN);
    expect(names(image)).toStrictEqual(["kiten cardsIn:"]);
    using again = Image.at(file);
    const [method] = again.methods();
    expect(method.snapshot()).toStrictEqual({
      author: "human",
      time: "2026-09-23T10:00:00.000Z",
      source: "do :column kiten ls where: column is: @column done",
      definition:
        "kiten define: cardsIn: purpose: ^мои в колонке^ do :column kiten ls where: column is: @column done",
    });
    expect(method.source().source).toStrictEqual(CARDS_IN.source().source);
  }));

it("define: того же имени заменяет метод", () =>
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
    expect(image.methods().length).toBe(1);
    expect(method.purposeLine()).toBe("образ: другое");
  }));

it("forget: убирает метод; нет метода — false", () =>
  withDir((file) => {
    using image = Image.at(file);
    image.define(CARDS_IN);
    expect(image.forget(["kiten"], "cardsIn:")).toBe(true);
    expect(image.methods()).toStrictEqual([]);
    expect(image.forget(["kiten"], "cardsIn:")).toBe(false);
  }));

it("метод другого процесса виден следующему чтению (data_version)", () =>
  withDir((file) => {
    using first = Image.at(file);
    first.define(CARDS_IN);
    expect(names(first)).toStrictEqual(["kiten cardsIn:"]);
    using second = Image.at(file);
    second.define(new ImageMethod({ ...CARDS_IN.record(), name: "mine" }));
    expect(names(first)).toStrictEqual(["kiten cardsIn:", "kiten mine"]);
    second.forget(["kiten"], "cardsIn:");
    expect(names(first)).toStrictEqual(["kiten mine"]);
  }));

it("файл появился после открытия — виден следующему чтению", () =>
  withDir((file) => {
    using first = Image.at(file);
    expect(first.methods()).toStrictEqual([]);
    using second = Image.at(file);
    second.define(CARDS_IN);
    expect(names(first)).toStrictEqual(["kiten cardsIn:"]);
  }));

it("мусор вместо файла — отказ «образ: …»", () =>
  withDir(async (file) => {
    await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    await writeFile(file, "это не база данных, а просто текст ".repeat(40));
    using image = Image.at(file);
    const err = thrown(() => image.methods(), ImageError);
    expect(err.message.startsWith("образ: ")).toBe(true);
  }));

it("нет каталога состояния — пусто; запись — отказ", () => {
  using image = Image.at(undefined);
  expect(image.methods()).toStrictEqual([]);
  thrown(
    () => image.define(CARDS_IN),
    ImageError,
    "образ: каталог состояния не задан (нет HOME)",
  );
});

it("метод: части имени, селектор вида, хэш исходника", () => {
  const two = new ImageMethod({ ...CARDS_IN.record(), name: "top:by:" });
  expect(two.parts()).toStrictEqual(["top:", "by:"]);
  expect(two.selector()).toBe("by:top:");
  expect(two.links()).toStrictEqual(["kiten", "top:by:"]);
  const unary = new ImageMethod({ ...CARDS_IN.record(), name: "mine" });
  expect(unary.parts()).toStrictEqual([]);
  expect(unary.selector()).toBe("mine");
  // printf '%s' 'do :column kiten ls where: column is: @column done' | sha256sum
  expect(CARDS_IN.hash()).toBe(
    "18a567aa75dff7782309620a91664dd1a4c91f0edec1b39c24b625cd448a89c2",
  );
});
