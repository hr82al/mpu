/**
 * `mpu ask image sync` (`image-sync.md`, «Сценарии»): образ и файлы
 * каталога сводятся в обе стороны по архиву. Стенд — `HOME` во временном
 * каталоге, `$H/mr/mp/mpu` создан заранее, Kaiten подменён.
 */

import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import { Image, imageSyncCommand } from "../image/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import {
  CARDS_IN_FILE,
  conflicted,
  FIRST,
  outcome,
  QUESTION,
  ruleOf,
  snapshot,
  SYNC,
  type Sync,
  tree,
  withSync,
} from "./testsync.ts";

it("1–2: три метода в пустой каталог, повтор — совпало 3, ничего не тронуто", () =>
  withSync(async (sync) => {
    await sync.three();
    const first = await sync.run(SYNC);
    expect([first.exit, first.stdout, first.stderr]).toStrictEqual([
      0,
      FIRST,
      QUESTION,
    ]);
    const files = await tree(sync.dir);
    expect(files["kiten/cardsIn:.mpu"]).toStrictEqual(CARDS_IN_FILE);
    expect(files["kiten/mine.mpu"]).toBe(
      "kiten define: mine purpose: ^мои^ do kiten ls done\n",
    );
    const image = await readFile(sync.imageFile);
    const second = await sync.run(SYNC);
    expect([second.exit, second.stdout]).toStrictEqual([
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
    expect(await tree(sync.dir)).toStrictEqual(files);
    expect(await readFile(sync.imageFile)).toStrictEqual(image);
  }));

it("3: правка назначения в файле — база из файла, автор human", () =>
  withSync(async (sync) => {
    await sync.synced();
    const path = `${sync.dir}/kiten/cardsIn:.mpu`;
    const text = await readFile(path, "utf8");
    await writeFile(
      path,
      text.replace("^мои в колонке^", "^мои карточки^"),
    );
    const ran = await sync.run(SYNC);
    expect([ran.exit, ran.stdout]).toStrictEqual([
      0,
      "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
    const help = await sync.run("kiten cardsIn: help");
    assert(help.stdout.includes("образ: мои карточки"), help.stdout);
    assert(help.stdout.includes("определён human"), help.stdout);
  }));

it("4: переопределение в базе — файл из базы", () =>
  withSync(async (sync) => {
    await sync.synced();
    await sync.run("ask kiten define: mine purpose: ^x^ do kiten ls done");
    const ran = await sync.run(SYNC);
    expect([ran.exit, ran.stdout]).toStrictEqual([
      0,
      "файл из базы\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
    expect(await readFile(`${sync.dir}/kiten/mine.mpu`, "utf8")).toBe(
      "kiten define: mine purpose: ^x^ do kiten ls done\n",
    );
  }));

it("5: изменено с обеих сторон — конфликт с адресом, стороны прежние", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const before = await snapshot(sync);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      1,
      "конфликт\tkiten cardsIn:\tkiten.cardsIn\nсовпало 2, изменено 0, конфликтов 1\n",
    ]);
    expect(await snapshot(sync)).toStrictEqual(before);
  }));

it("5, 20: dry на конфликте — та же строка конфликт, ничего не тронуто", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const before = await snapshot(sync);
    expect(outcome(await sync.run("ask image sync dry"))).toStrictEqual([
      1,
      "конфликт\tkiten cardsIn:\tkiten.cardsIn\nсовпало 2, изменено 0, конфликтов 1\n",
    ]);
    expect(await snapshot(sync)).toStrictEqual(before);
  }));

it("6: files: решает конфликт — база из файла", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const ran = await sync.run("ask image sync files: kiten.cardsIn");
    expect(ran.stderr).toBe(
      "выполнить mpu image sync files: kiten.cardsIn? [y/N] ",
    );
    expect(outcome(ran)).toStrictEqual([
      0,
      "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
  }));

it("7: image.db удалена — новый метод из каждого файла, посев правила", () =>
  withSync(async (sync) => {
    await sync.synced();
    await rm(sync.imageFile);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "новый метод\tkiten cardsIn:\nновый метод\tkiten mine\nновый метод\tkiten shipped\n" +
      "совпало 0, изменено 3, конфликтов 0\n",
    ]);
    expect(ruleOf(sync.policy, "kiten cardsIn:")).toBe("allow");
    // Повтор после записи файл → база: хэш архива — хэш метода базы.
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

it("8–9: каталог очищен — отказ массового удаления; deletes: allow — удалён метод", () =>
  withSync(async (sync) => {
    await sync.synced();
    await rm(sync.dir, { recursive: true });
    const before = await readFile(sync.imageFile);
    const refused = await sync.run(SYNC);
    expect([refused.exit, refused.stdout, refused.stderr]).toStrictEqual([
      2,
      "",
      QUESTION +
      "mpu image sync: удалилось бы 3 из 3 методов (база) — вызывай mpu ask image sync deletes: allow\n",
    ]);
    expect(refused.refusals.map((one) => [one.reason, one.hint])).toStrictEqual(
      [[
        "удалилось бы",
        ["ask", "image", "sync", "deletes:", "allow"],
      ]],
    );
    expect(await readFile(sync.imageFile)).toStrictEqual(before);
    expect(outcome(await sync.run("ask image sync deletes: allow")))
      .toStrictEqual([
        0,
        "удалён метод\tkiten cardsIn:\nудалён метод\tkiten mine\nудалён метод\tkiten shipped\n" +
        "совпало 0, изменено 3, конфликтов 0\n",
      ]);
    for (const path of ["kiten cardsIn:", "kiten mine", "kiten shipped"]) {
      expect(ruleOf(sync.policy, path), path).toStrictEqual(undefined);
    }
  }));

it("10, 46: удалён с обеих сторон — строка архива снимается молча; dry её не снимает", () =>
  withSync(async (sync) => {
    await sync.synced();
    expect((await sync.run("ask kiten forget: cardsIn")).exit).toBe(0);
    await rm(`${sync.dir}/kiten/cardsIn:.mpu`);
    const quiet = [0, "совпало 2, изменено 0, конфликтов 0\n"];
    const archived = () => {
      using image = Image.at(sync.imageFile);
      return image.archive(sync.dir).has("kiten cardsIn:");
    };
    expect(outcome(await sync.run("ask image sync dry"))).toStrictEqual(quiet);
    expect(archived()).toBe(true);
    expect(outcome(await sync.run(SYNC))).toStrictEqual(quiet);
    expect(archived()).toBe(false);
    expect(outcome(await sync.run(SYNC))).toStrictEqual(quiet);
  }));

/** Строки `файл не разобран` при синхронизированных трёх методах. */
const UNREAD: readonly (readonly [string, string, string])[] = [
  ["11", "kiten/x:.mpu", "в файле нет строки определения"],
  [
    "12",
    "kiten/ls.mpu",
    "mpu kiten define: ls у kiten уже есть",
  ],
  ["53a", "kiten/foo:.mpu", "в файле kiten bar, ждали kiten foo:"],
  [
    "55",
    "nope/x.mpu",
    "mpu nope define: метод — только у команды или группы",
  ],
  [
    "43",
    "kiten/x.mpu",
    "файл не в UTF-8: байт 0xC3 на смещении 6",
  ],
];

/** Содержимое файлов для строк `UNREAD`. */
const UNREAD_TEXT: Record<string, string | Uint8Array> = {
  "kiten/x:.mpu": "мусор",
  "kiten/ls.mpu": "kiten define: ls purpose: ^x^ do kiten ls done",
  "kiten/foo:.mpu": "kiten define: bar purpose: ^x^ do kiten ls done",
  "nope/x.mpu": "nope define: x purpose: ^x^ do kiten ls done",
  "kiten/x.mpu": new Uint8Array([
    0x6b,
    0x69,
    0x74,
    0x65,
    0x6e,
    0x20,
    0xc3,
    0x20,
  ]),
};

async function put(dir: string, path: string, text: string | Uint8Array) {
  const full = `${dir}/${path}`;
  await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  if (typeof text === "string") await writeFile(full, text);
  else await writeFile(full, text);
}

describe("11, 12, 43, 53, 55: неразобранный файл — строка отчёта, код 1, метод не тронут", () => {
  for (const [name, path, reason] of UNREAD) {
    it(name, () =>
      withSync(async (sync) => {
        await sync.synced();
        await put(sync.dir, path, UNREAD_TEXT[path]);
        expect(outcome(await sync.run(SYNC))).toStrictEqual([
          1,
          `файл не разобран\t${path}\t${reason}\nсовпало 3, изменено 0, конфликтов 0\n`,
        ]);
      }));
  }
});

it("57: чужие файлы каталога не читаются и не удаляются", () =>
  withSync(async (sync) => {
    await sync.synced();
    await put(sync.dir, "kiten/notes.txt", "заметки");
    await put(sync.dir, "kiten/.cardsIn:.mpu.swp", "мусор");
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
    const files = await tree(sync.dir);
    expect(files["kiten/notes.txt"]).toBe("заметки");
    expect(files["kiten/.cardsIn:.mpu.swp"]).toBe("мусор");
  }));

const PING_ALL =
  "kiten define: pingAll purpose: ^пинг^ do kiten ls each: do :c kiten comment id: @c id text: ping done done";

it("13: база пуста, метод из файла, достигающий записи, — новый метод, правило ask", () =>
  withSync(async (sync) => {
    await put(sync.dir, "kiten/pingAll.mpu", PING_ALL);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "новый метод\tkiten pingAll\nсовпало 0, изменено 1, конфликтов 0\n",
    ]);
    expect(ruleOf(sync.policy, "kiten pingAll")).toBe("ask");
    const help = await sync.run("kiten pingAll help");
    assert(help.stdout.includes("определён human"), help.stdout);
  }));

describe("14: метод зовёт метод этого же запуска — правила allow в обоих порядках файлов", () => {
  const files: Record<string, string> = {
    "kiten/a.mpu": "kiten define: a purpose: ^a^ do kiten b done",
    "kiten/b.mpu": "kiten define: b purpose: ^b^ do kiten ls done",
  };
  for (
    const order of [["kiten/a.mpu", "kiten/b.mpu"], [
      "kiten/b.mpu",
      "kiten/a.mpu",
    ]]
  ) {
    it(order.join(" → "), () =>
      withSync(async (sync) => {
        for (const path of order) await put(sync.dir, path, files[path]);
        expect(outcome(await sync.run(SYNC))).toStrictEqual([
          0,
          "новый метод\tkiten a\nновый метод\tkiten b\nсовпало 0, изменено 2, конфликтов 0\n",
        ]);
        expect(ruleOf(sync.policy, "kiten a")).toBe("allow");
        expect(ruleOf(sync.policy, "kiten b")).toBe("allow");
        expect(outcome(await sync.run(SYNC))).toStrictEqual([
          0,
          "совпало 2, изменено 0, конфликтов 0\n",
        ]);
      }));
  }
});

it("15: каталог без права записи — сбой по методу, архив прежний; после chmod — как 1", () =>
  withSync(async (sync) => {
    await sync.three();
    await mkdir(`${sync.dir}/kiten`, { recursive: true });
    await chmod(`${sync.dir}/kiten`, 0o555);
    const ran = await sync.run(SYNC);
    const lines = ran.stdout.split("\n");
    expect(ran.exit).toBe(1);
    expect(lines.map((line) => line.split("\t").slice(0, 2).join("\t")))
      .toStrictEqual([
        "сбой\tkiten cardsIn:",
        "сбой\tkiten mine",
        "сбой\tkiten shipped",
        "совпало 0, изменено 0, конфликтов 0",
        "",
      ]);
    assert(lines[0].split("\t")[2].length > 0, lines[0]);
    await chmod(`${sync.dir}/kiten`, 0o755);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([0, FIRST]);
  }));

it("16–17: каталог вне права — отказ до вопроса, код 2", () =>
  withSync(async (sync) => {
    const tail = ` — каталог образа только под ${sync.dir}\n`;
    const given = await sync.run("ask image sync dir: /tmp/x");
    expect([given.exit, given.stdout, given.stderr]).toStrictEqual([
      2,
      "",
      `mpu image sync dir: /tmp/x: нет права записи в /tmp/x${tail}`,
    ]);
    const set = await sync.run("ask config key: image.dir value: /tmp/x");
    expect(set.exit, set.stderr).toBe(0);
    const keyed = await sync.run(SYNC);
    expect([keyed.exit, keyed.stdout, keyed.stderr]).toStrictEqual([
      2,
      "",
      `mpu image sync: нет права записи в /tmp/x${tail}`,
    ]);
  }));

it("18, 48: другой каталог — свой архив; вложенный каталог образа — неразобранные файлы", () =>
  withSync(async (sync) => {
    await sync.synced();
    const other = `${sync.dir}/other`;
    const set = await sync.run(
      `ask config key: image.dir value: ${other}`,
    );
    expect(set.exit, set.stderr).toBe(0);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([0, FIRST]);
    expect((await tree(other))["kiten/cardsIn:.mpu"]).toStrictEqual(
      CARDS_IN_FILE,
    );
    expect((await sync.run("ask config unset key: image.dir")).exit).toBe(0);
    const refusal =
      "mpu other kiten define: метод — только у команды или группы";
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      1,
      ["cardsIn:", "mine", "shipped"].map((name) =>
        `файл не разобран\tother/kiten/${name}.mpu\t${refusal}\n`
      ).join("") + "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

it("19: относительный dir: — от cwd строки", () =>
  withSync(async (sync) => {
    await sync.three();
    const ran = await sync.run("ask image sync dir: image", {
      cwd: `${sync.home}/mr/mp/mpu`,
    });
    expect(outcome(ran)).toStrictEqual([0, FIRST]);
    expect((await tree(sync.dir))["kiten/cardsIn:.mpu"]).toStrictEqual(
      CARDS_IN_FILE,
    );
  }));

it("20: dry — тот же stdout, ничего не изменено; повтор без dry — тот же stdout", () =>
  withSync(async (sync) => {
    await sync.synced();
    const path = `${sync.dir}/kiten/cardsIn:.mpu`;
    await writeFile(
      path,
      CARDS_IN_FILE.replace("^мои в колонке^", "^мои карточки^"),
    );
    const before = await snapshot(sync);
    const expected =
      "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n";
    const dry = await sync.run("ask image sync dry");
    expect([dry.exit, dry.stdout, dry.stderr]).toStrictEqual([
      0,
      expected,
      "выполнить mpu image sync dry? [y/N] ",
    ]);
    expect(await snapshot(sync)).toStrictEqual(before);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([0, expected]);
  }));

describe("21–22: без ask — адресный отказ двери", () => {
  for (const line of ["image sync dry", "image sync"]) {
    it(line, () =>
      withSync(async (sync) => {
        const ran = await sync.run(line);
        expect([ran.exit, ran.stdout, ran.stderr]).toStrictEqual([
          2,
          "",
          `mpu ${line}: требует подтверждения — вызывай mpu ask ${line}\n`,
        ]);
      }));
  }
});

it("23: ответ n — не подтверждено, ничего не изменено", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const before = await snapshot(sync);
    const ran = await sync.run(SYNC, { answers: ["n"] });
    expect([ran.exit, ran.stdout, ran.stderr]).toStrictEqual([
      1,
      "",
      `${QUESTION}mpu image sync: не подтверждено\n`,
    ]);
    expect(await snapshot(sync)).toStrictEqual(before);
  }));

it("31, 53: справка, messages корня (группы — E10, export_test.ts)", () =>
  withSync(async (sync) => {
    const help = await sync.run("image sync help");
    expect(help.exit).toBe(0);
    assert(
      help.stdout.includes(
        "\n\nСводит методы образа с файлами каталога в обе стороны.\n\n",
      ),
      help.stdout,
    );
    assert(
      help.stdout.replaceAll("\n", " ").includes(
        "Звать после правки файлов методов или перед коммитом каталога образа: в отличие от ручного копирования видит, какая сторона изменилась с прошлого раза, и ничего не теряет — метод, изменённый с обеих сторон, не трогает.",
      ),
      help.stdout,
    );
    assert(help.stdout.includes("Варианты:\n  dry "), help.stdout);
    const root = (await sync.run("ask messages")).stdout.split("\n");
    const at = root.indexOf("image\tметоды образа и файлы каталога");
    assert(at > 0, root.join("\n"));
    assert(root[at - 1] < "image", root[at - 1]);
    assert(root[at + 1].startsWith("init\t"), root[at + 1]);
    // Обычный взгляд: у группы есть исполнимый без `ask` ребёнок —
    // `export` (`image-export.md`, E10).
    const plain = (await sync.run("messages")).stdout;
    assert(plain.includes("image\tметоды образа и файлы каталога\n"), plain);
  }));

it("34–35: мусор вместо файла не удаляет метод и не входит в счёт удалений", () =>
  withSync(async (sync) => {
    await sync.synced();
    await writeFile(`${sync.dir}/kiten/cardsIn:.mpu`, "мусор");
    const before = await readFile(sync.imageFile);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      1,
      "файл не разобран\tkiten/cardsIn:.mpu\tв файле нет строки определения\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    expect(await readFile(sync.imageFile)).toStrictEqual(before);
    expect(ruleOf(sync.policy, "kiten cardsIn:")).toBe("allow");
    await rm(`${sync.dir}/kiten/mine.mpu`);
    await rm(`${sync.dir}/kiten/shipped.mpu`);
    const refused = await sync.run(SYNC);
    expect([refused.exit, refused.stdout, refused.stderr]).toStrictEqual([
      2,
      "",
      QUESTION +
      "mpu image sync: удалилось бы 2 из 3 методов (база) — вызывай mpu ask image sync deletes: allow\n",
    ]);
  }));

it("36: define: получателя deny — сбой, база и архив пусты", () =>
  withSync(async (sync) => {
    const denied = await sync.run(["deny:", "--", "kiten define:"]);
    expect(denied.exit, denied.stderr).toBe(0);
    await put(sync.dir, "kiten/pingAll.mpu", PING_ALL);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      1,
      "сбой\tkiten pingAll\tзапрещено правилом «kiten define:»\n" +
      "совпало 0, изменено 0, конфликтов 0\n",
    ]);
    expect(ruleOf(sync.policy, "kiten pingAll")).toStrictEqual(undefined);
    using image = Image.at(sync.imageFile);
    expect(image.methods().length).toBe(0);
    expect(image.archive(sync.dir).size).toBe(0);
  }));

it("37: forget: получателя deny — сбой, метод в базе", () =>
  withSync(async (sync) => {
    await sync.synced();
    const denied = await sync.run(["deny:", "--", "kiten forget:"]);
    expect(denied.exit, denied.stderr).toBe(0);
    await rm(`${sync.dir}/kiten/mine.mpu`);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      1,
      "сбой\tkiten mine\tзапрещено правилом «kiten forget:»\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    expect(ruleOf(sync.policy, "kiten mine")).toBe("allow");
  }));

it("41: BOM и \\r\\n — те же слова, файл не переписан", () =>
  withSync(async (sync) => {
    await sync.synced();
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(
        "kiten define: mine purpose: ^мои^ do kiten ls done\r\n",
      ),
    ]);
    await writeFile(`${sync.dir}/kiten/mine.mpu`, bytes);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
    expect(new Uint8Array(await readFile(`${sync.dir}/kiten/mine.mpu`)))
      .toStrictEqual(
        bytes,
      );
  }));

it("42: неразрывный пробел — часть слова, повтор совпадает", () =>
  withSync(async (sync) => {
    await sync.three();
    const defined = await sync.run(
      "ask kiten define: nb purpose: ^a b^ do kiten ls done",
    );
    expect(defined.exit, defined.stderr).toBe(0);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "новый файл\tkiten cardsIn:\nновый файл\tkiten mine\nновый файл\tkiten nb\n" +
      "новый файл\tkiten shipped\nсовпало 0, изменено 4, конфликтов 0\n",
    ]);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "совпало 4, изменено 0, конфликтов 0\n",
    ]);
    assert(
      (await readFile(`${sync.dir}/kiten/nb.mpu`, "utf8")).includes(
        "^a b^",
      ),
    );
  }));

it("44: имя файла без двоеточия — не тот метод", () =>
  withSync(async (sync) => {
    await sync.synced();
    await copyFile(
      `${sync.dir}/kiten/cardsIn:.mpu`,
      `${sync.dir}/kiten/cardsIn.mpu`,
    );
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      1,
      "файл не разобран\tkiten/cardsIn.mpu\tв файле kiten cardsIn:, ждали kiten cardsIn\n" +
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

it("45: forget: в базе — удалён файл", () =>
  withSync(async (sync) => {
    await sync.synced();
    expect((await sync.run("ask kiten forget: mine")).exit).toBe(0);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "удалён файл\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
    expect((await tree(sync.dir))["kiten/mine.mpu"]).toStrictEqual(undefined);
  }));

it("49: посев image sync — ask, пути image нет", () =>
  withSync(async (sync) => {
    const rules = JSON.parse((await sync.run("policy")).stdout) as {
      path: string;
      verdict: string;
    }[];
    expect(rules.filter((rule) => rule.path === "image sync")).toStrictEqual([{
      path: "image sync",
      verdict: "ask",
    }]);
    expect(rules.filter((rule) => rule.path === "image")).toStrictEqual([]);
  }));

/** Файл метода стенда: путь от каталога. */
function fileOf(sync: Sync, name: string): string {
  return `${sync.dir}/kiten/${name}.mpu`;
}

/** Назначение изменено в файле метода `name`. */
async function editFile(sync: Sync, name: string) {
  const path = fileOf(sync, name);
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace(/\^[^^]*\^/, "^из файла^"));
}

/** Метод `name` переопределён в базе с новым назначением. */
async function redefine(sync: Sync, name: string, body = "do kiten ls done") {
  const ran = await sync.run(
    `ask kiten define: ${name} purpose: ^из базы^ ${body}`,
  );
  expect(ran.exit, ran.stderr).toBe(0);
}

describe("Конфликт на этот запуск: base:/files: выбирают сторону", () => {
  const summary = (changed: number, conflicts: number) =>
    `совпало 2, изменено ${changed}, конфликтов ${conflicts}\n`;
  const cases: readonly (readonly [
    string,
    (sync: Sync) => Promise<void>,
    string,
    string,
    number?,
  ])[] = [
    [
      "base: — файл из базы",
      async (sync) => {
        await editFile(sync, "mine");
        await redefine(sync, "mine");
      },
      "ask image sync base: kiten.mine",
      "файл из базы\tkiten mine\n" + summary(1, 0),
    ],
    [
      "удалён в базе, изменён в файле; base: — удалён файл",
      async (sync) => {
        await editFile(sync, "mine");
        await sync.run("ask kiten forget: mine");
      },
      "ask image sync base: kiten.mine",
      "удалён файл\tkiten mine\n" + summary(1, 0),
    ],
    [
      "удалён в базе, изменён в файле; files: — база из файла",
      async (sync) => {
        await editFile(sync, "mine");
        await sync.run("ask kiten forget: mine");
      },
      "ask image sync files: kiten.mine",
      "база из файла\tkiten mine\n" + summary(1, 0),
    ],
    [
      "изменён в базе, удалён в файле; files: — удалён метод",
      async (sync) => {
        await redefine(sync, "mine");
        await rm(fileOf(sync, "mine"));
      },
      "ask image sync files: kiten.mine",
      "удалён метод\tkiten mine\n" + summary(1, 0),
    ],
    [
      "изменён в базе, удалён в файле; base: — файл из базы",
      async (sync) => {
        await redefine(sync, "mine");
        await rm(fileOf(sync, "mine"));
      },
      "ask image sync base: kiten.mine",
      "файл из базы\tkiten mine\n" + summary(1, 0),
    ],
    [
      "base: у метода без конфликта — как без ключа",
      async (sync) => {
        await editFile(sync, "shipped");
        await redefine(
          sync,
          "shipped",
          "do kiten ls where: column is: Готово done",
        );
      },
      "ask image sync base: kiten.mine",
      "конфликт\tkiten shipped\tkiten.shipped\n" + summary(0, 1),
      1,
    ],
    [
      "files: дважды — оба из файла",
      async (sync) => {
        for (const name of ["mine", "shipped"]) {
          await editFile(sync, name);
          await redefine(sync, name);
        }
      },
      "ask image sync files: kiten.mine files: kiten.shipped",
      "база из файла\tkiten mine\nбаза из файла\tkiten shipped\n" +
      "совпало 1, изменено 2, конфликтов 0\n",
    ],
  ];
  for (const [name, given, line, expected, exit = 0] of cases) {
    it(name, () =>
      withSync(async (sync) => {
        await sync.synced();
        await given(sync);
        expect(outcome(await sync.run(line))).toStrictEqual([exit, expected]);
      }));
  }
});

it("Конфликт: kiten.mine называет и mine, и mine:", () =>
  withSync(async (sync) => {
    await sync.three();
    const keyed = await sync.run(
      "ask kiten define: mine: purpose: ^m^ do :x kiten ls done",
    );
    expect(keyed.exit, keyed.stderr).toBe(0);
    expect((await sync.run(SYNC)).exit).toBe(0);
    await editFile(sync, "mine");
    await editFile(sync, "mine:");
    await redefine(sync, "mine");
    await redefine(sync, "mine:", "do :x kiten ls done");
    expect(outcome(await sync.run("ask image sync files: kiten.mine")))
      .toStrictEqual([
        0,
        "база из файла\tkiten mine\nбаза из файла\tkiten mine:\n" +
        "совпало 2, изменено 2, конфликтов 0\n",
      ]);
  }));

describe("Конфликт: неверный адрес — отказ до вопроса, код 2", () => {
  const cases: readonly (readonly [string, string])[] = [
    [
      "ask image sync base: kiten.nope",
      "mpu image sync base: kiten.nope: нет метода kiten.nope ни в базе, ни в файлах\n",
    ],
    [
      "ask image sync base: kiten.cardsIn files: kiten.cardsIn",
      "mpu image sync base: kiten.cardsIn files: kiten.cardsIn: kiten.cardsIn — и в base:, и в files:\n",
    ],
    [
      "ask image sync base: cardsIn",
      "mpu image sync base: cardsIn: адрес метода — получатель.имя: cardsIn\n",
    ],
    ["ask image sync base: kiten.cardsIn:", "у ключа base нет значения\n"],
  ];
  for (const [line, stderr] of cases) {
    it(line, () =>
      withSync(async (sync) => {
        await sync.synced();
        const ran = await sync.run(line);
        expect([ran.exit, ran.stdout, ran.stderr]).toStrictEqual([
          2,
          "",
          stderr,
        ]);
      }));
  }
});

/** Метод `m<n>` стенда: унарный, тело читает Kaiten. */
function numbered(n: number): string {
  return `ask kiten define: m${n} purpose: ^м${n}^ do kiten ls done`;
}

/** `total` методов синхронизированы. */
async function syncedMany(sync: Sync, total: number) {
  for (let n = 1; n <= total; n++) {
    expect((await sync.run(numbered(n))).exit).toBe(0);
  }
  expect((await sync.run(SYNC)).exit).toBe(0);
}

/** Удалены файлы методов `m1…m<count>`: столько удалений в базе. */
async function removeFiles(sync: Sync, count: number) {
  for (let n = 1; n <= count; n++) await rm(fileOf(sync, `m${n}`));
}

describe("Предохранители: N из M удалений стороны", () => {
  const passes: readonly (readonly [number, number])[] = [[1, 3], [1, 2], [
    2,
    4,
  ]];
  for (const [deleted, of] of passes) {
    it(`${deleted} из ${of} — проходит`, () =>
      withSync(async (sync) => {
        await syncedMany(sync, of);
        await removeFiles(sync, deleted);
        const ran = await sync.run(SYNC);
        expect(ran.exit, ran.stderr).toBe(0);
        assert(ran.stdout.includes(`изменено ${deleted},`), ran.stdout);
      }));
  }
  const refused: readonly (readonly [number, number])[] = [[2, 3], [3, 5]];
  for (const [deleted, of] of refused) {
    it(`${deleted} из ${of} — отказ`, () =>
      withSync(async (sync) => {
        await syncedMany(sync, of);
        await removeFiles(sync, deleted);
        const ran = await sync.run(SYNC);
        expect([ran.exit, ran.stdout, ran.stderr]).toStrictEqual([
          2,
          "",
          QUESTION +
          `mpu image sync: удалилось бы ${deleted} из ${of} методов (база) — вызывай mpu ask image sync deletes: allow\n`,
        ]);
      }));
  }
  it("1 из 1 (файлы) — отказ", () =>
    withSync(async (sync) => {
      await syncedMany(sync, 1);
      expect((await sync.run("ask kiten forget: m1")).exit).toBe(0);
      const ran = await sync.run(SYNC);
      expect([ran.exit, ran.stderr]).toStrictEqual([
        2,
        QUESTION +
        "mpu image sync: удалилось бы 1 из 1 методов (файлы) — вызывай mpu ask image sync deletes: allow\n",
      ]);
    }));
  it("10 из 10, deletes: allow — проходит", () =>
    withSync(async (sync) => {
      await syncedMany(sync, 10);
      await removeFiles(sync, 10);
      const ran = await sync.run("ask image sync deletes: allow");
      expect(ran.exit, ran.stderr).toBe(0);
      expect(
        ran.stdout.split("\n").filter((line) => line.startsWith("удалён метод"))
          .length,
      ).toBe(10);
    }));
  it("база 1 из 2 и файлы 1 из 2 — проходит", () =>
    withSync(async (sync) => {
      // База {m1, m2}, файлы {m2, m3}: у каждой стороны 1 из 2.
      await syncedMany(sync, 3);
      await removeFiles(sync, 1);
      expect((await sync.run("ask kiten forget: m3")).exit).toBe(0);
      expect(outcome(await sync.run(SYNC))).toStrictEqual([
        0,
        "удалён метод\tkiten m1\nудалён файл\tkiten m3\n" +
        "совпало 1, изменено 2, конфликтов 0\n",
      ]);
    }));
  it(
    "dry, 3 из 5 — тот же отказ, в совете dry",
    () =>
      withSync(async (sync) => {
        await syncedMany(sync, 5);
        await removeFiles(sync, 3);
        const ran = await sync.run("ask image sync dry");
        expect([ran.exit, ran.stdout, ran.stderr]).toStrictEqual([
          2,
          "",
          "выполнить mpu image sync dry? [y/N] " +
          "mpu image sync dry: удалилось бы 3 из 5 методов (база) — вызывай mpu ask image sync dry deletes: allow\n",
        ]);
        expect(ran.refusals.map((one) => one.hint)).toStrictEqual([[
          "ask",
          "image",
          "sync",
          "dry",
          "deletes:",
          "allow",
        ]]);
      }),
  );
});

it("Файл метода: получатель из двух звеньев — вложенный каталог", () =>
  withSync(async (sync) => {
    const defined = await sync.run(
      "ask kiten ls define: inColumn purpose: ^колонка^ do :c kiten ls where: column is: @c done",
    );
    expect(defined.exit, defined.stderr).toBe(0);
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "новый файл\tkiten ls inColumn:\nсовпало 0, изменено 1, конфликтов 0\n",
    ]);
    expect((await tree(sync.dir))["kiten/ls/inColumn:.mpu"]).toBe(
      "kiten ls define: inColumn: purpose: ^колонка^ do :c kiten ls where: column is: @c done\n",
    );
  }));

it("Результат — текст: end json — отказ до исполнения; deletes: не allow — отказ реестра", () =>
  withSync(async (sync) => {
    await sync.three();
    const json = await sync.run("ask image sync end json");
    expect([json.exit, json.stdout, json.stderr]).toStrictEqual([
      2,
      "",
      "mpu ask image sync end: не понимает json\n",
    ]);
    expect(await tree(sync.dir)).toStrictEqual({});
    const deletes = await sync.run("ask image sync deletes: yes");
    expect([deletes.exit, deletes.stdout]).toStrictEqual([2, ""]);
    expect(deletes.stderr).toStrictEqual(
      'mpu image sync: invalid deletes: value "yes"; ' +
        "попробуй: mpu image sync --help\n",
    );
  }));

it("журнал: строка image sync — одна запись, и у исполненной, и у отказа до вопроса", () =>
  withSync(async (sync) => {
    await sync.three();
    for (const line of [SYNC, "ask image sync dir: /tmp/x"]) {
      const ran = await sync.run(line);
      expect([ran.native.length, ran.records], line).toStrictEqual([1, []]);
    }
  }));

/** Голдены справки группы `image` (`image-sync.md`, «Сценарии»). */
const GOLDENS = new URL("./testdata/image-sync/", import.meta.url);

describe("голдены testdata/image-sync: справка и messages — прогон на стенде", () => {
  const lines: readonly (readonly [string, string])[] = [
    ["help.txt", "image sync help"],
    ["messages.txt", "ask image messages"],
  ];
  for (const [name, line] of lines) {
    it(name, () =>
      withSync(async (sync) => {
        const ran = await sync.run(line);
        expect(ran.exit, ran.stderr).toBe(0);
        expect(ran.stdout).toStrictEqual(
          await readFile(new URL(name, GOLDENS), "utf8"),
        );
      }));
  }
});

it("команда реестра image sync вне ядра не исполняется", async () => {
  const failure = imageSyncCommand.invoke([], makeFakeIo());
  await expect(failure).rejects.toThrow(Error);
  await expect(failure).rejects.toThrow("строку image sync исполняет ядро");
});

it("отчёт: по получателю, затем по имени — не по склейке", () =>
  withSync(async (sync) => {
    for (
      const line of [
        "ask kiten define: mine purpose: ^мои^ do kiten ls done",
        "ask kiten ls define: inColumn purpose: ^к^ do :c kiten ls where: column is: @c done",
      ]
    ) {
      expect((await sync.run(line)).exit).toBe(0);
    }
    expect(outcome(await sync.run(SYNC))).toStrictEqual([
      0,
      "новый файл\tkiten mine\nновый файл\tkiten ls inColumn:\n" +
      "совпало 0, изменено 2, конфликтов 0\n",
    ]);
  }));
