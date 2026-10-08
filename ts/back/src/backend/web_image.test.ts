/**
 * Экраны образа глазами `back` (`web-image.md`, «Сценарии», «Golden-
 * примеры»): голдены стенда сценария 1, снимок по схеме, ответы строк
 * экрана — правка и удаление метода, `image sync` с его отчётами и
 * отказами, строки правил на узлах методов.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { wordsOf } from "@mpu/language/frames";
import { lineHash } from "../image/sides.ts";
import SCHEMA from "./schema.json" with { type: "json" };
import { violations } from "./testschema.ts";
import {
  LINES_AT,
  type WebImage,
  webImageGoldens,
  withWebImage,
} from "./testwebimage.ts";
import type { Frame } from "./testback.ts";

/** Узел снимка, как его отдаёт `tree.snapshot`. */
interface Node {
  readonly path: readonly string[];
  readonly summary: string;
  readonly keys: readonly unknown[];
  readonly image?: {
    readonly author: string;
    readonly time: string;
    readonly source: string;
    readonly definition: string;
  };
}

async function nodeOf(
  stand: WebImage,
  path: string,
): Promise<Node | undefined> {
  const snapshot = (await stand.rpc("tree.snapshot")) as { nodes: Node[] };
  return snapshot.nodes.find((node) => node.path.join(" ") === path);
}

/** Строка экрана; вопрос — с ответом `answer`. */
async function screen(
  stand: WebImage,
  words: readonly string[],
  answer?: "y" | "n",
): Promise<{ asked: string | undefined; reply: Frame }> {
  const first = await stand.screen(words);
  if (!("ticket" in first)) return { asked: undefined, reply: first };
  expect(answer !== undefined, `вопрос без ответа: ${first.ask}`).toBe(true);
  return {
    asked: String(first.ask),
    reply: await stand.answer(first, answer ?? "n"),
  };
}

const refused = (reason: string, text: string, exit: number, hint = null) => ({
  stdout: "",
  stderr: `${text}\n`,
  refusal: { reason, hint, candidates: [], text },
  exit,
});

const DEFINITION =
  "kiten define: cardsIn: purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done";
const EDITED = DEFINITION.replace(
  "do :col kiten ls where: column is: @col done",
  "do :c kiten ls where: column is: @c done",
);
const DEFINED = {
  stdout: '{"path":"kiten cardsIn:","verdict":"allow"}\n',
  stderr: "",
  exit: 0,
};

it("голдены стенда сценария 1: tree.snapshot и policy.tree", async () => {
  const taken = await webImageGoldens();
  const read = async (name: string) =>
    JSON.parse(
      await readFile(new URL(`testdata/web/${name}`, import.meta.url), "utf8"),
    );
  expect(taken.snapshot).toStrictEqual(await read("snapshot-image.json"));
  expect(taken.policyTree).toStrictEqual(await read("policy-tree-image.json"));
});

it("tree.snapshot живого back — по схеме rpc.tree.snapshot", () =>
  withWebImage(async (stand) => {
    const snapshot = (await stand.rpc("tree.snapshot")) as { nodes: Node[] };
    const node = SCHEMA.$defs["rpc.tree.snapshot"];
    expect(violations(SCHEMA, node, snapshot)).toStrictEqual([]);
    // Сверка не слепа: лишнее и пропавшее поле узла образа — нарушения.
    const method = snapshot.nodes.findIndex((one) => one.image !== undefined);
    // Копия для порчи: поля узлов правятся по имени.
    const spoiled = structuredClone(snapshot) as unknown as {
      nodes: Record<string, unknown>[];
    };
    spoiled.nodes[method].image = { ...snapshot.nodes[method].image, x: 1 };
    expect(violations(SCHEMA, node, spoiled)).toStrictEqual([
      `$.nodes[${method}].image: лишнее поле x`,
    ]);
    const { definition: _, ...bare } = snapshot.nodes[method].image ?? {};
    spoiled.nodes[method].image = bare;
    expect(violations(SCHEMA, node, spoiled)).toStrictEqual([
      `$.nodes[${method}].image: нет обязательного definition`,
    ]);
  }));

it("сценарии 3–4: «Сохранить» без правки — вопрос, «Да», автор web, часы back", () =>
  withWebImage(async (stand) => {
    const before = await nodeOf(stand, "kiten cardsIn:");
    expect(before?.image?.definition).toStrictEqual(DEFINITION);
    const got = await screen(stand, ["ask", ...wordsOf(DEFINITION)], "y");
    expect(got.asked).toStrictEqual(`выполнить mpu ${DEFINITION}? [y/N] `);
    expect(got.reply).toStrictEqual(DEFINED);
    const after = await nodeOf(stand, "kiten cardsIn:");
    expect([after?.summary, after?.keys]).toStrictEqual([
      before?.summary,
      before?.keys,
    ]);
    expect(after?.image).toStrictEqual({
      ...before?.image,
      author: "web",
      time: LINES_AT,
    });
  }));

it("сценарии 5–6: правка тела — «Да» меняет исходник, «Нет» — отказ", () =>
  withWebImage(async (stand) => {
    const no = await screen(stand, ["ask", ...wordsOf(EDITED)], "n");
    expect(no.asked).toStrictEqual(`выполнить mpu ${EDITED}? [y/N] `);
    expect(no.reply).toStrictEqual(
      refused("не подтверждено", `mpu ${EDITED}: не подтверждено`, 1),
    );
    expect((await nodeOf(stand, "kiten cardsIn:"))?.image?.source).toBe(
      "do :col kiten ls where: column is: @col done",
    );
    const yes = await screen(stand, ["ask", ...wordsOf(EDITED)], "y");
    expect(yes.reply).toStrictEqual(DEFINED);
    const image = (await nodeOf(stand, "kiten cardsIn:"))?.image;
    expect([image?.source, image?.author, image?.time]).toStrictEqual([
      "do :c kiten ls where: column is: @c done",
      "web",
      LINES_AT,
    ]);
  }));

it("сценарий 7: без назначения — отказ без вопроса, код 2", () =>
  withWebImage(async (stand) => {
    const text = DEFINITION.replace(" purpose: ^мои в колонке^", "");
    const got = await screen(stand, ["ask", ...wordsOf(text)]);
    expect(got.asked).toStrictEqual(undefined);
    expect(got.reply).toStrictEqual(
      refused(
        "метод без назначения",
        "mpu kiten define: метод без назначения: purpose: ^…^",
        2,
      ),
    );
  }));

it("сценарий 8: другое имя — новый метод, прежний на месте", () =>
  withWebImage(async (stand) => {
    const text = DEFINITION.replace("cardsIn:", "cardsOf:");
    const got = await screen(stand, ["ask", ...wordsOf(text)], "y");
    expect(got.reply).toStrictEqual({
      ...DEFINED,
      stdout: '{"path":"kiten cardsOf:","verdict":"allow"}\n',
    });
    expect((await nodeOf(stand, "kiten cardsOf:")) !== undefined).toBe(true);
    expect((await nodeOf(stand, "kiten cardsIn:")) !== undefined).toBe(true);
  }));

it("сценарии 9, 11: вопрос решает правило пути у back", () =>
  withWebImage(async (stand) => {
    await stand.terminal(["allow:", "--", "kiten define:"], ["y"]);
    const saved = await screen(stand, ["ask", ...wordsOf(DEFINITION)]);
    expect([saved.asked, saved.reply]).toStrictEqual([undefined, DEFINED]);
    await stand.terminal(["deny:", "--", "kiten forget:"], ["y"]);
    const forgot = await screen(stand, ["ask", "kiten", "forget:", "cardsIn:"]);
    expect(forgot.asked).toStrictEqual(undefined);
    expect(forgot.reply).toStrictEqual(
      refused(
        "запрещено правилом",
        "mpu kiten forget: cardsIn:: запрещено правилом «kiten forget:»",
        1,
      ),
    );
    expect((await nodeOf(stand, "kiten cardsIn:")) !== undefined).toBe(true);
  }));

it("сценарий 10: «Удалить метод» — forget: последним звеном пути", () =>
  withWebImage(async (stand) => {
    const got = await screen(
      stand,
      ["ask", "kiten", "forget:", "cardsIn:"],
      "y",
    );
    expect(got.asked).toBe("выполнить mpu kiten forget: cardsIn:? [y/N] ");
    expect(got.reply).toStrictEqual({
      stdout: '{"path":"kiten cardsIn:","verdict":null}\n',
      stderr: "",
      exit: 0,
    });
    expect(await nodeOf(stand, "kiten cardsIn:")).toStrictEqual(undefined);
  }));

it("сценарий 12: протокол корня — семь методов по алфавиту", () =>
  withWebImage(async (stand) => {
    const snapshot = (await stand.rpc("tree.snapshot")) as {
      protocol: unknown;
    };
    expect(snapshot.protocol).toStrictEqual([
      {
        selector: "candidates:",
        kind: "keyword",
        purpose: "значения ключа, начинающиеся с like:",
      },
      {
        selector: "formats",
        kind: "unary",
        purpose: "форматы результата — без исполнения",
      },
      { selector: "help", kind: "unary", purpose: "справка объекта" },
      {
        selector: "keys",
        kind: "unary",
        purpose: "ключи ключевого сообщения команды",
      },
      {
        selector: "messages",
        kind: "unary",
        purpose: "собственные сообщения объекта",
      },
      {
        selector: "understands:",
        kind: "keyword",
        purpose: "понимает ли объект сообщение",
      },
      { selector: "variants", kind: "unary", purpose: "варианты команды" },
    ]);
  }));

/** «Синхронизировано» (`image-sync.md`, сц. 1). */
async function synced(stand: WebImage) {
  expect((await stand.terminal("ask image sync", ["y"])).exit).toBe(0);
}

const SYNC = ["ask", "image", "sync"];
const DRY = ["ask", "image", "sync", "dry"];

it("сценарии 14, 22: «Синхронизировать» и «Проверить» с «Нет»", () =>
  withWebImage(async (stand) => {
    await synced(stand);
    const sync = await screen(stand, SYNC, "y");
    expect(sync.asked).toBe("выполнить mpu image sync? [y/N] ");
    expect(sync.reply).toStrictEqual({
      stdout: "совпало 3, изменено 0, конфликтов 0\n",
      stderr: "",
      exit: 0,
    });
    const no = await screen(stand, DRY, "n");
    expect(no.reply).toStrictEqual(
      refused("не подтверждено", "mpu image sync dry: не подтверждено", 1),
    );
  }));

/** Файл `cardsIn:` каталога образа: `^мои в колонке^` → `^мои карточки^`. */
async function editFile(stand: WebImage) {
  const file = `${stand.dir}/kiten/cardsIn:.mpu`;
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace("^мои в колонке^", "^мои карточки^"));
}

it("сценарий 15: «Проверить» — отчёт, база прежняя", () =>
  withWebImage(async (stand) => {
    await synced(stand);
    await editFile(stand);
    const got = await screen(stand, DRY, "y");
    expect(got.asked).toBe("выполнить mpu image sync dry? [y/N] ");
    expect(got.reply).toStrictEqual({
      stdout:
        "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
      stderr: "",
      exit: 0,
    });
    expect((await nodeOf(stand, "kiten cardsIn:"))?.summary).toBe(
      "образ: мои в колонке",
    );
  }));

/** Стенд сценария 16: файл правлен, база переопределена с `^x^`. */
async function conflicted(stand: WebImage) {
  await synced(stand);
  await editFile(stand);
  const redefined = await stand.terminal(
    "ask kiten define: cardsIn purpose: ^x^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
    ["y"],
  );
  expect(redefined.exit).toBe(0);
}

it("сценарии 16–17, 19: конфликт кодом 1, «взять файлы» по адресу", () =>
  withWebImage(async (stand) => {
    await conflicted(stand);
    const dry = await screen(stand, DRY, "y");
    expect(dry.reply).toStrictEqual({
      stdout:
        "конфликт\tkiten cardsIn:\tkiten.cardsIn\nсовпало 2, изменено 0, конфликтов 1\n",
      stderr: "",
      exit: 1,
    });
    expect((await nodeOf(stand, "kiten cardsIn:"))?.image?.definition).toBe(
      "kiten define: cardsIn: purpose: ^x^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
    );
    const files = await screen(
      stand,
      [...SYNC, "files:", "kiten.cardsIn"],
      "y",
    );
    expect(files.asked).toBe(
      "выполнить mpu image sync files: kiten.cardsIn? [y/N] ",
    );
    expect(files.reply).toStrictEqual({
      stdout:
        "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
      stderr: "",
      exit: 0,
    });
    const node = await nodeOf(stand, "kiten cardsIn:");
    expect([
      node?.summary,
      node?.image?.author,
      node?.image?.time,
    ]).toStrictEqual(["образ: мои карточки", "web", LINES_AT]);
    expect(node?.image?.definition).toBe(
      "kiten define: cardsIn: purpose: ^мои карточки^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
    );
  }));

it("сценарий 18: «взять файлы» — прогон полный", () =>
  withWebImage(async (stand) => {
    await conflicted(stand);
    const file = `${stand.dir}/kiten/mine.mpu`;
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("^мои^", "^мои все^"));
    const got = await screen(stand, [...SYNC, "files:", "kiten.cardsIn"], "y");
    expect(got.reply.stdout).toBe(
      "база из файла\tkiten cardsIn:\nбаза из файла\tkiten mine\nсовпало 1, изменено 2, конфликтов 0\n",
    );
  }));

it("сценарий 20: массовое удаление — отказ с hint, база цела", () =>
  withWebImage(async (stand) => {
    await synced(stand);
    await rm(`${stand.dir}/kiten`, { recursive: true });
    const got = await screen(stand, SYNC, "y");
    const text =
      "mpu image sync: удалилось бы 3 из 3 методов (база) — вызывай mpu ask image sync deletes: allow";
    expect(got.reply).toStrictEqual({
      stdout: "",
      stderr: `${text}\n`,
      refusal: {
        reason: "удалилось бы",
        hint: ["ask", "image", "sync", "deletes:", "allow"],
        candidates: [],
        text,
      },
      exit: 2,
    });
    expect((await nodeOf(stand, "kiten cardsIn:")) !== undefined).toBe(true);
  }));

it("сценарий 21: каталог вне разрешённого — отказ без вопроса", () =>
  withWebImage(async (stand) => {
    const set = await stand.terminal(
      "ask config key: image.dir value: /tmp/x",
      ["y"],
    );
    expect(set.exit, JSON.stringify(set)).toBe(0);
    const got = await screen(stand, SYNC);
    expect(got.asked).toStrictEqual(undefined);
    expect(got.reply).toStrictEqual(
      refused(
        "отказ",
        `mpu image sync: нет права записи в /tmp/x — каталог образа только под ${stand.home}/mr/mp/mpu/image`,
        2,
      ),
    );
  }));

it("сценарии 23–25: строка правила с -- пишет правило ровно своего узла", () =>
  withWebImage(async (stand) => {
    const rule = async (words: string[], asked: string, stdout: string) => {
      const got = await screen(stand, words, "y");
      expect(got.asked).toStrictEqual(asked);
      expect(got.reply).toStrictEqual({ stdout, stderr: "", exit: 0 });
    };
    await rule(
      ["deny:", "--", "kiten cardsIn:"],
      "изменить правило: kiten cardsIn: → deny? [y/N] ",
      '{"path":"kiten cardsIn:","verdict":"deny"}\n',
    );
    const tree = async () =>
      ((await stand.rpc("policy.tree")) as Record<string, unknown>[]).find(
        (one) => String(one.path) === "kiten,cardsIn:",
      );
    expect(await tree()).toStrictEqual({
      path: ["kiten", "cardsIn:"],
      verdict: "deny",
      rule: "kiten cardsIn:",
      own: true,
    });
    await rule(
      ["forget:", "--", "kiten cardsIn:"],
      "изменить правило: kiten cardsIn: → forget? [y/N] ",
      '{"path":"kiten cardsIn:","verdict":null}\n',
    );
    expect(await tree()).toStrictEqual({
      path: ["kiten", "cardsIn:"],
      verdict: "ask",
      rule: null,
      own: false,
    });
    expect((await nodeOf(stand, "kiten cardsIn:")) !== undefined).toBe(true);
    await rule(
      ["allow:", "--", "kiten"],
      "изменить правило: kiten → allow? [y/N] ",
      '{"path":"kiten","verdict":"allow"}\n',
    );
  }));

it("слова definition строкой define: — прежний хэш (ключи, U+00A0)", () =>
  withWebImage(async (stand) => {
    const defined = await stand.terminal(
      "ask kiten define: spaced purpose: ^мои все^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
      ["y"],
    );
    expect(defined.exit, JSON.stringify(defined)).toBe(0);
    const before =
      (await nodeOf(stand, "kiten spaced:"))?.image?.definition ?? "";
    const got = await screen(stand, ["ask", ...wordsOf(before)], "y");
    expect(got.reply.exit, JSON.stringify(got.reply)).toBe(0);
    const after =
      (await nodeOf(stand, "kiten spaced:"))?.image?.definition ?? "";
    expect(lineHash(after)).toStrictEqual(lineHash(before));
    expect(after.includes("^мои все^ keys: ^id колонки^")).toBe(true);
  }));
