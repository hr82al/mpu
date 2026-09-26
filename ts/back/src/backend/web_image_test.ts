/**
 * Экраны образа глазами `back` (`web-image.md`, «Сценарии», «Golden-
 * примеры»): голдены стенда сценария 1, снимок по схеме, ответы строк
 * экрана — правка и удаление метода, `image sync` с его отчётами и
 * отказами, строки правил на узлах методов.
 */

import { assertEquals } from "@std/assert";
import { wordsOf } from "../frames/mod.ts";
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
  const snapshot = await stand.rpc("tree.snapshot") as { nodes: Node[] };
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
  assertEquals(answer !== undefined, true, `вопрос без ответа: ${first.ask}`);
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

Deno.test("голдены стенда сценария 1: tree.snapshot и policy.tree", async () => {
  const taken = await webImageGoldens();
  const read = async (name: string) =>
    JSON.parse(
      await Deno.readTextFile(new URL(`testdata/web/${name}`, import.meta.url)),
    );
  assertEquals(taken.snapshot, await read("snapshot-image.json"));
  assertEquals(taken.policyTree, await read("policy-tree-image.json"));
});

Deno.test("tree.snapshot живого back — по схеме rpc.tree.snapshot", () =>
  withWebImage(async (stand) => {
    const snapshot = await stand.rpc("tree.snapshot") as { nodes: Node[] };
    const node = SCHEMA.$defs["rpc.tree.snapshot"];
    assertEquals(violations(SCHEMA, node, snapshot), []);
    // Сверка не слепа: лишнее и пропавшее поле узла образа — нарушения.
    const method = snapshot.nodes.findIndex((one) => one.image !== undefined);
    // Копия для порчи: поля узлов правятся по имени.
    const spoiled = structuredClone(snapshot) as unknown as {
      nodes: Record<string, unknown>[];
    };
    spoiled.nodes[method].image = { ...snapshot.nodes[method].image, x: 1 };
    assertEquals(violations(SCHEMA, node, spoiled), [
      `$.nodes[${method}].image: лишнее поле x`,
    ]);
    const { definition: _, ...bare } = snapshot.nodes[method].image ?? {};
    spoiled.nodes[method].image = bare;
    assertEquals(violations(SCHEMA, node, spoiled), [
      `$.nodes[${method}].image: нет обязательного definition`,
    ]);
  }));

Deno.test("сценарии 3–4: «Сохранить» без правки — вопрос, «Да», автор web, часы back", () =>
  withWebImage(async (stand) => {
    const before = await nodeOf(stand, "kiten cardsIn:");
    assertEquals(before?.image?.definition, DEFINITION);
    const got = await screen(stand, ["ask", ...wordsOf(DEFINITION)], "y");
    assertEquals(got.asked, `выполнить mpu ${DEFINITION}? [y/N] `);
    assertEquals(got.reply, DEFINED);
    const after = await nodeOf(stand, "kiten cardsIn:");
    assertEquals([after?.summary, after?.keys], [
      before?.summary,
      before?.keys,
    ]);
    assertEquals(after?.image, {
      ...before?.image,
      author: "web",
      time: LINES_AT,
    });
  }));

Deno.test("сценарии 5–6: правка тела — «Да» меняет исходник, «Нет» — отказ", () =>
  withWebImage(async (stand) => {
    const no = await screen(stand, ["ask", ...wordsOf(EDITED)], "n");
    assertEquals(no.asked, `выполнить mpu ${EDITED}? [y/N] `);
    assertEquals(
      no.reply,
      refused("не подтверждено", `mpu ${EDITED}: не подтверждено`, 1),
    );
    assertEquals(
      (await nodeOf(stand, "kiten cardsIn:"))?.image?.source,
      "do :col kiten ls where: column is: @col done",
    );
    const yes = await screen(stand, ["ask", ...wordsOf(EDITED)], "y");
    assertEquals(yes.reply, DEFINED);
    const image = (await nodeOf(stand, "kiten cardsIn:"))?.image;
    assertEquals(
      [image?.source, image?.author, image?.time],
      ["do :c kiten ls where: column is: @c done", "web", LINES_AT],
    );
  }));

Deno.test("сценарий 7: без назначения — отказ без вопроса, код 2", () =>
  withWebImage(async (stand) => {
    const text = DEFINITION.replace(" purpose: ^мои в колонке^", "");
    const got = await screen(stand, ["ask", ...wordsOf(text)]);
    assertEquals(got.asked, undefined);
    assertEquals(
      got.reply,
      refused(
        "метод без назначения",
        "mpu kiten define: метод без назначения: purpose: ^…^",
        2,
      ),
    );
  }));

Deno.test("сценарий 8: другое имя — новый метод, прежний на месте", () =>
  withWebImage(async (stand) => {
    const text = DEFINITION.replace("cardsIn:", "cardsOf:");
    const got = await screen(stand, ["ask", ...wordsOf(text)], "y");
    assertEquals(got.reply, {
      ...DEFINED,
      stdout: '{"path":"kiten cardsOf:","verdict":"allow"}\n',
    });
    assertEquals((await nodeOf(stand, "kiten cardsOf:")) !== undefined, true);
    assertEquals((await nodeOf(stand, "kiten cardsIn:")) !== undefined, true);
  }));

Deno.test("сценарии 9, 11: вопрос решает правило пути у back", () =>
  withWebImage(async (stand) => {
    await stand.terminal(["allow:", "--", "kiten define:"], ["y"]);
    const saved = await screen(stand, ["ask", ...wordsOf(DEFINITION)]);
    assertEquals([saved.asked, saved.reply], [undefined, DEFINED]);
    await stand.terminal(["deny:", "--", "kiten forget:"], ["y"]);
    const forgot = await screen(stand, ["ask", "kiten", "forget:", "cardsIn:"]);
    assertEquals(forgot.asked, undefined);
    assertEquals(
      forgot.reply,
      refused(
        "запрещено правилом",
        "mpu kiten forget: cardsIn:: запрещено правилом «kiten forget:»",
        1,
      ),
    );
    assertEquals((await nodeOf(stand, "kiten cardsIn:")) !== undefined, true);
  }));

Deno.test("сценарий 10: «Удалить метод» — forget: последним звеном пути", () =>
  withWebImage(async (stand) => {
    const got = await screen(
      stand,
      ["ask", "kiten", "forget:", "cardsIn:"],
      "y",
    );
    assertEquals(got.asked, "выполнить mpu kiten forget: cardsIn:? [y/N] ");
    assertEquals(got.reply, {
      stdout: '{"path":"kiten cardsIn:","verdict":null}\n',
      stderr: "",
      exit: 0,
    });
    assertEquals(await nodeOf(stand, "kiten cardsIn:"), undefined);
  }));

Deno.test("сценарий 12: протокол корня — семь методов по алфавиту", () =>
  withWebImage(async (stand) => {
    const snapshot = await stand.rpc("tree.snapshot") as { protocol: unknown };
    assertEquals(snapshot.protocol, [
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
  assertEquals((await stand.terminal("ask image sync", ["y"])).exit, 0);
}

const SYNC = ["ask", "image", "sync"];
const DRY = ["ask", "image", "sync", "dry"];

Deno.test("сценарии 14, 22: «Синхронизировать» и «Проверить» с «Нет»", () =>
  withWebImage(async (stand) => {
    await synced(stand);
    const sync = await screen(stand, SYNC, "y");
    assertEquals(sync.asked, "выполнить mpu image sync? [y/N] ");
    assertEquals(sync.reply, {
      stdout: "совпало 3, изменено 0, конфликтов 0\n",
      stderr: "",
      exit: 0,
    });
    const no = await screen(stand, DRY, "n");
    assertEquals(
      no.reply,
      refused("не подтверждено", "mpu image sync dry: не подтверждено", 1),
    );
  }));

/** Файл `cardsIn:` каталога образа: `^мои в колонке^` → `^мои карточки^`. */
async function editFile(stand: WebImage) {
  const file = `${stand.dir}/kiten/cardsIn:.mpu`;
  const text = await Deno.readTextFile(file);
  await Deno.writeTextFile(
    file,
    text.replace("^мои в колонке^", "^мои карточки^"),
  );
}

Deno.test("сценарий 15: «Проверить» — отчёт, база прежняя", () =>
  withWebImage(async (stand) => {
    await synced(stand);
    await editFile(stand);
    const got = await screen(stand, DRY, "y");
    assertEquals(got.asked, "выполнить mpu image sync dry? [y/N] ");
    assertEquals(got.reply, {
      stdout:
        "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
      stderr: "",
      exit: 0,
    });
    assertEquals(
      (await nodeOf(stand, "kiten cardsIn:"))?.summary,
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
  assertEquals(redefined.exit, 0);
}

Deno.test("сценарии 16–17, 19: конфликт кодом 1, «взять файлы» по адресу", () =>
  withWebImage(async (stand) => {
    await conflicted(stand);
    const dry = await screen(stand, DRY, "y");
    assertEquals(dry.reply, {
      stdout:
        "конфликт\tkiten cardsIn:\tkiten.cardsIn\nсовпало 2, изменено 0, конфликтов 1\n",
      stderr: "",
      exit: 1,
    });
    assertEquals(
      (await nodeOf(stand, "kiten cardsIn:"))?.image?.definition,
      "kiten define: cardsIn: purpose: ^x^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
    );
    const files = await screen(
      stand,
      [...SYNC, "files:", "kiten.cardsIn"],
      "y",
    );
    assertEquals(
      files.asked,
      "выполнить mpu image sync files: kiten.cardsIn? [y/N] ",
    );
    assertEquals(files.reply, {
      stdout:
        "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
      stderr: "",
      exit: 0,
    });
    const node = await nodeOf(stand, "kiten cardsIn:");
    assertEquals(
      [node?.summary, node?.image?.author, node?.image?.time],
      ["образ: мои карточки", "web", LINES_AT],
    );
    assertEquals(
      node?.image?.definition,
      "kiten define: cardsIn: purpose: ^мои карточки^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
    );
  }));

Deno.test("сценарий 18: «взять файлы» — прогон полный", () =>
  withWebImage(async (stand) => {
    await conflicted(stand);
    const file = `${stand.dir}/kiten/mine.mpu`;
    const text = await Deno.readTextFile(file);
    await Deno.writeTextFile(file, text.replace("^мои^", "^мои все^"));
    const got = await screen(stand, [...SYNC, "files:", "kiten.cardsIn"], "y");
    assertEquals(
      got.reply.stdout,
      "база из файла\tkiten cardsIn:\nбаза из файла\tkiten mine\nсовпало 1, изменено 2, конфликтов 0\n",
    );
  }));

Deno.test("сценарий 20: массовое удаление — отказ с hint, база цела", () =>
  withWebImage(async (stand) => {
    await synced(stand);
    await Deno.remove(`${stand.dir}/kiten`, { recursive: true });
    const got = await screen(stand, SYNC, "y");
    const text =
      "mpu image sync: удалилось бы 3 из 3 методов (база) — вызывай mpu ask image sync deletes: allow";
    assertEquals(got.reply, {
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
    assertEquals((await nodeOf(stand, "kiten cardsIn:")) !== undefined, true);
  }));

Deno.test("сценарий 21: каталог вне разрешённого — отказ без вопроса", () =>
  withWebImage(async (stand) => {
    const set = await stand.terminal(
      "ask config key: image.dir value: /tmp/x",
      ["y"],
    );
    assertEquals(set.exit, 0, JSON.stringify(set));
    const got = await screen(stand, SYNC);
    assertEquals(got.asked, undefined);
    assertEquals(
      got.reply,
      refused(
        "отказ",
        `mpu image sync: нет права записи в /tmp/x — каталог образа только под ${stand.home}/mr/mp/mpu/image`,
        2,
      ),
    );
  }));

Deno.test("сценарии 23–25: строка правила с -- пишет правило ровно своего узла", () =>
  withWebImage(async (stand) => {
    const rule = async (words: string[], asked: string, stdout: string) => {
      const got = await screen(stand, words, "y");
      assertEquals(got.asked, asked);
      assertEquals(got.reply, { stdout, stderr: "", exit: 0 });
    };
    await rule(
      ["deny:", "--", "kiten cardsIn:"],
      "изменить правило: kiten cardsIn: → deny? [y/N] ",
      '{"path":"kiten cardsIn:","verdict":"deny"}\n',
    );
    const tree = async () =>
      (await stand.rpc("policy.tree") as Record<string, unknown>[])
        .find((one) => String(one.path) === "kiten,cardsIn:");
    assertEquals(await tree(), {
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
    assertEquals(await tree(), {
      path: ["kiten", "cardsIn:"],
      verdict: "ask",
      rule: null,
      own: false,
    });
    assertEquals((await nodeOf(stand, "kiten cardsIn:")) !== undefined, true);
    await rule(
      ["allow:", "--", "kiten"],
      "изменить правило: kiten → allow? [y/N] ",
      '{"path":"kiten","verdict":"allow"}\n',
    );
  }));

Deno.test("слова definition строкой define: — прежний хэш (ключи, U+00A0)", () =>
  withWebImage(async (stand) => {
    const defined = await stand.terminal(
      "ask kiten define: spaced purpose: ^мои все^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
      ["y"],
    );
    assertEquals(defined.exit, 0, JSON.stringify(defined));
    const before = (await nodeOf(stand, "kiten spaced:"))?.image?.definition ??
      "";
    const got = await screen(stand, ["ask", ...wordsOf(before)], "y");
    assertEquals(got.reply.exit, 0, JSON.stringify(got.reply));
    const after = (await nodeOf(stand, "kiten spaced:"))?.image?.definition ??
      "";
    assertEquals(lineHash(after), lineHash(before));
    assertEquals(after.includes("^мои все^ keys: ^id колонки^"), true);
  }));
