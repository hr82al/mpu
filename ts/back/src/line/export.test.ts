/**
 * `mpu image export` (`image-export.md`, «Сценарии»): из решения по
 * методу применяется только база → файлы, прочее — строкой «ждёт
 * человека». Стенд — как у `image sync` (`testsync.ts`).
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import {
  CARDS_IN_FILE,
  conflicted,
  outcome,
  snapshot,
  type Sync,
  tree,
  withSync,
} from "./testsync.ts";

const EXPORT = "image export";

/** Строка без вопроса: stderr пуст. */
async function exported(sync: Sync, line = EXPORT) {
  const ran = await sync.run(line, { answers: [] });
  expect(ran.stderr, line).toBe("");
  return ran;
}

/** Образ побайтово: база и архив. */
async function imageBytes(sync: Sync): Promise<Uint8Array> {
  return new Uint8Array(await readFile(sync.imageFile));
}

it("E1: правка файла — ждёт человека, база и архив прежние", () =>
  withSync(async (sync) => {
    await sync.synced();
    const path = `${sync.dir}/kiten/cardsIn:.mpu`;
    await writeFile(
      path,
      CARDS_IN_FILE.replace("^мои в колонке^", "^мои карточки^"),
    );
    const before = await imageBytes(sync);
    expect(outcome(await exported(sync))).toStrictEqual([
      0,
      "ждёт человека\tбаза из файла\tkiten cardsIn:\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    expect(await imageBytes(sync)).toStrictEqual(before);
    const help = await sync.run("kiten cardsIn: help");
    assert(help.stdout.includes("образ: мои в колонке"), help.stdout);
  }));

it("E2: переопределение в базе — файл из базы", () =>
  withSync(async (sync) => {
    await sync.synced();
    await sync.run("ask kiten define: mine purpose: ^x^ do kiten ls done");
    expect(outcome(await exported(sync))).toStrictEqual([
      0,
      "файл из базы\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
    expect(await readFile(`${sync.dir}/kiten/mine.mpu`, "utf8")).toBe(
      "kiten define: mine purpose: ^x^ do kiten ls done\n",
    );
    // Архив записан: повтор — совпало.
    expect(outcome(await exported(sync))).toStrictEqual([
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

it("удалён в базе — удалён файл применяется, строка архива снята", () =>
  withSync(async (sync) => {
    await sync.synced();
    expect((await sync.run("ask kiten forget: mine")).exit).toBe(0);
    expect(outcome(await exported(sync))).toStrictEqual([
      0,
      "удалён файл\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
    expect(Object.keys(await tree(sync.dir)).sort()).toStrictEqual([
      "kiten/cardsIn:.mpu",
      "kiten/shipped.mpu",
    ]);
    // Архив без `mine`: новый метод с тем же именем — новый файл, а не
    // «удалён метод».
    await sync.run("ask kiten define: mine purpose: ^мои^ do kiten ls done");
    expect(outcome(await exported(sync))).toStrictEqual([
      0,
      "новый файл\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
  }));

it("E3: deletes: — не понимает", () =>
  withSync(async (sync) => {
    const ran = await sync.run("image export deletes: allow");
    expect([ran.exit, ran.stdout, ran.stderr]).toStrictEqual([
      2,
      "",
      "mpu image export: не понимает deletes:\n",
    ]);
  }));

it("E4: без человека — исполнено без вопроса", () =>
  withSync(async (sync) => {
    await sync.synced();
    await sync.run("ask kiten define: mine purpose: ^x^ do kiten ls done");
    const ran = await sync.run(EXPORT, { answers: [], terminal: false });
    expect([ran.exit, ran.stdout, ran.stderr]).toStrictEqual([
      0,
      "файл из базы\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
      "",
    ]);
  }));

it("E5: справка — однострока и повод звать", () =>
  withSync(async (sync) => {
    const help = await sync.run("image export help");
    expect(help.exit).toBe(0);
    assert(
      help.stdout.includes(
        "\n\nПишет в файлы каталога образа то, что изменилось в базе.\n\n",
      ),
      help.stdout,
    );
    assert(
      help.stdout.replaceAll("\n", " ").includes(
        "Её зовёт суточный таймер; человеку — когда нужны файлы без вопроса: пишет только в каталог образа, а всё, что меняет базу, оставляет строкой «ждёт человека» для image sync.",
      ),
      help.stdout,
    );
  }));

it("E6: конфликт — ждёт человека с адресом, код 0, ничего не тронуто", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const before = await snapshot(sync);
    expect(outcome(await exported(sync))).toStrictEqual([
      0,
      "ждёт человека\tконфликт\tkiten cardsIn:\tkiten.cardsIn\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    expect(await snapshot(sync)).toStrictEqual(before);
  }));

it("E7: новый файл метода — ждёт человека без проверок define:", () =>
  withSync(async (sync) => {
    await sync.synced();
    await writeFile(
      `${sync.dir}/kiten/ls.mpu`,
      "kiten define: ls purpose: ^x^ do kiten ls done",
    );
    expect(outcome(await exported(sync))).toStrictEqual([
      0,
      "ждёт человека\tновый метод\tkiten ls\n" +
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

it("E8: мусор вместо файла — файл не разобран, код 1", () =>
  withSync(async (sync) => {
    await sync.synced();
    await writeFile(`${sync.dir}/kiten/cardsIn:.mpu`, "мусор");
    const before = await imageBytes(sync);
    expect(outcome(await exported(sync))).toStrictEqual([
      1,
      "файл не разобран\tkiten/cardsIn:.mpu\tв файле нет строки определения\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    expect(await imageBytes(sync)).toStrictEqual(before);
  }));

it("E9: каталог очищен — ждёт человека, база цела, отказа нет", () =>
  withSync(async (sync) => {
    await sync.synced();
    await rm(sync.dir, { recursive: true });
    const before = await imageBytes(sync);
    const ran = await exported(sync);
    expect(outcome(ran)).toStrictEqual([
      0,
      "ждёт человека\tудалён метод\tkiten cardsIn:\n" +
      "ждёт человека\tудалён метод\tkiten mine\n" +
      "ждёт человека\tудалён метод\tkiten shipped\n" +
      "совпало 0, изменено 0, конфликтов 0\n",
    ]);
    expect(ran.refusals).toStrictEqual([]);
    expect(await imageBytes(sync)).toStrictEqual(before);
    expect(await tree(sync.dir)).toStrictEqual({});
  }));

it("E10: messages — export обычным взглядом, sync через дверь", () =>
  withSync(async (sync) => {
    expect(outcome(await sync.run("image messages"))).toStrictEqual([
      0,
      "export\tПишет в файлы каталога образа то, что изменилось в базе.\n",
    ]);
    expect(outcome(await sync.run("ask image messages"))).toStrictEqual([
      0,
      "sync\tСводит методы образа с файлами каталога в обе стороны.\n",
    ]);
  }));

it("E11: посев — export allow, sync ask, пути image нет", () =>
  withSync(async (sync) => {
    const rules = JSON.parse((await sync.run("policy")).stdout) as {
      path: string;
      verdict: string;
    }[];
    expect(rules.filter((rule) => rule.path.startsWith("image"))).toStrictEqual(
      [
        { path: "image export", verdict: "allow" },
        { path: "image sync", verdict: "ask" },
      ],
    );
  }));

/** Ещё два метода: у стенда пять. */
const TWO_MORE = [
  "ask kiten define: alpha purpose: ^a^ do kiten ls done",
  "ask kiten define: beta purpose: ^b^ do kiten ls done",
];

describe("Массовое удаление файлов: 3 из 5 — отказ, совет ведёт в image sync", () => {
  const cases = [
    {
      line: EXPORT,
      said: "mpu image export",
      hint: ["ask", "image", "sync", "deletes:", "allow"],
    },
    {
      line: "image export dir: image",
      said: "mpu image export dir: image",
      hint: ["ask", "image", "sync", "dir:", "image", "deletes:", "allow"],
    },
  ];
  for (const one of cases) {
    it(one.line, () =>
      withSync(async (sync) => {
        await sync.three();
        for (const line of TWO_MORE) {
          expect((await sync.run(line)).exit).toBe(0);
        }
        expect((await sync.run("ask image sync")).exit).toBe(0);
        for (const name of ["alpha", "beta", "cardsIn"]) {
          expect((await sync.run(`ask kiten forget: ${name}`)).exit).toBe(0);
        }
        const before = await snapshot(sync);
        const ran = await sync.run(one.line, {
          answers: [],
          cwd: `${sync.home}/mr/mp/mpu`,
        });
        expect([ran.exit, ran.stdout, ran.stderr]).toStrictEqual([
          2,
          "",
          `${one.said}: удалилось бы 3 из 5 методов (файлы) — вызывай ` +
          `mpu ${one.hint.join(" ")}\n`,
        ]);
        expect(ran.refusals.map((r) => [r.reason, r.hint])).toStrictEqual([[
          "удалилось бы",
          one.hint,
        ]]);
        expect(await snapshot(sync)).toStrictEqual(before);
      }));
  }
});

it("журнал: строка image export — одна запись", () =>
  withSync(async (sync) => {
    await sync.three();
    const ran = await exported(sync);
    expect([ran.exit, ran.native.length, ran.records]).toStrictEqual([
      0,
      1,
      [],
    ]);
  }));

/** Голден справки (`image-export.md`, E5): пересобирает исполнитель. */
const HELP_GOLDEN = new URL(
  "./testdata/image-export/help.txt",
  import.meta.url,
);

it("голден testdata/image-export/help.txt — прогон на стенде", () =>
  withSync(async (sync) => {
    const ran = await sync.run("image export help");
    expect(ran.exit, ran.stderr).toBe(0);
    expect(ran.stdout).toStrictEqual(await readFile(HELP_GOLDEN, "utf8"));
  }));
