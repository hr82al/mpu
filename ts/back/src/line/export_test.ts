/**
 * `mpu image export` (`image-export.md`, «Сценарии»): из решения по
 * методу применяется только база → файлы, прочее — строкой «ждёт
 * человека». Стенд — как у `image sync` (`testsync.ts`).
 */

import { assert, assertEquals } from "@std/assert";
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
  assertEquals(ran.stderr, "", line);
  return ran;
}

/** Образ побайтово: база и архив. */
function imageBytes(sync: Sync): Promise<Uint8Array> {
  return Deno.readFile(sync.imageFile);
}

Deno.test("E1: правка файла — ждёт человека, база и архив прежние", () =>
  withSync(async (sync) => {
    await sync.synced();
    const path = `${sync.dir}/kiten/cardsIn:.mpu`;
    await Deno.writeTextFile(
      path,
      CARDS_IN_FILE.replace("^мои в колонке^", "^мои карточки^"),
    );
    const before = await imageBytes(sync);
    assertEquals(outcome(await exported(sync)), [
      0,
      "ждёт человека\tбаза из файла\tkiten cardsIn:\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    assertEquals(await imageBytes(sync), before);
    const help = await sync.run("kiten cardsIn: help");
    assert(help.stdout.includes("образ: мои в колонке"), help.stdout);
  }));

Deno.test("E2: переопределение в базе — файл из базы", () =>
  withSync(async (sync) => {
    await sync.synced();
    await sync.run("ask kiten define: mine purpose: ^x^ do kiten ls done");
    assertEquals(outcome(await exported(sync)), [
      0,
      "файл из базы\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
    assertEquals(
      await Deno.readTextFile(`${sync.dir}/kiten/mine.mpu`),
      "kiten define: mine purpose: ^x^ do kiten ls done\n",
    );
    // Архив записан: повтор — совпало.
    assertEquals(outcome(await exported(sync)), [
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

Deno.test("удалён в базе — удалён файл применяется, строка архива снята", () =>
  withSync(async (sync) => {
    await sync.synced();
    assertEquals((await sync.run("ask kiten forget: mine")).exit, 0);
    assertEquals(outcome(await exported(sync)), [
      0,
      "удалён файл\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
    assertEquals(Object.keys(await tree(sync.dir)).sort(), [
      "kiten/cardsIn:.mpu",
      "kiten/shipped.mpu",
    ]);
    // Архив без `mine`: новый метод с тем же именем — новый файл, а не
    // «удалён метод».
    await sync.run("ask kiten define: mine purpose: ^мои^ do kiten ls done");
    assertEquals(outcome(await exported(sync)), [
      0,
      "новый файл\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
  }));

Deno.test("E3: deletes: — не понимает", () =>
  withSync(async (sync) => {
    const ran = await sync.run("image export deletes: allow");
    assertEquals(
      [ran.exit, ran.stdout, ran.stderr],
      [2, "", "mpu image export: не понимает deletes:\n"],
    );
  }));

Deno.test("E4: без человека — исполнено без вопроса", () =>
  withSync(async (sync) => {
    await sync.synced();
    await sync.run("ask kiten define: mine purpose: ^x^ do kiten ls done");
    const ran = await sync.run(EXPORT, { answers: [], terminal: false });
    assertEquals([ran.exit, ran.stdout, ran.stderr], [
      0,
      "файл из базы\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
      "",
    ]);
  }));

Deno.test("E5: справка — однострока и повод звать", () =>
  withSync(async (sync) => {
    const help = await sync.run("image export help");
    assertEquals(help.exit, 0);
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

Deno.test("E6: конфликт — ждёт человека с адресом, код 0, ничего не тронуто", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const before = await snapshot(sync);
    assertEquals(outcome(await exported(sync)), [
      0,
      "ждёт человека\tконфликт\tkiten cardsIn:\tkiten.cardsIn\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    assertEquals(await snapshot(sync), before);
  }));

Deno.test("E7: новый файл метода — ждёт человека без проверок define:", () =>
  withSync(async (sync) => {
    await sync.synced();
    await Deno.writeTextFile(
      `${sync.dir}/kiten/ls.mpu`,
      "kiten define: ls purpose: ^x^ do kiten ls done",
    );
    assertEquals(outcome(await exported(sync)), [
      0,
      "ждёт человека\tновый метод\tkiten ls\n" +
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

Deno.test("E8: мусор вместо файла — файл не разобран, код 1", () =>
  withSync(async (sync) => {
    await sync.synced();
    await Deno.writeTextFile(`${sync.dir}/kiten/cardsIn:.mpu`, "мусор");
    const before = await imageBytes(sync);
    assertEquals(outcome(await exported(sync)), [
      1,
      "файл не разобран\tkiten/cardsIn:.mpu\tв файле нет строки определения\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    assertEquals(await imageBytes(sync), before);
  }));

Deno.test("E9: каталог очищен — ждёт человека, база цела, отказа нет", () =>
  withSync(async (sync) => {
    await sync.synced();
    await Deno.remove(sync.dir, { recursive: true });
    const before = await imageBytes(sync);
    const ran = await exported(sync);
    assertEquals(outcome(ran), [
      0,
      "ждёт человека\tудалён метод\tkiten cardsIn:\n" +
      "ждёт человека\tудалён метод\tkiten mine\n" +
      "ждёт человека\tудалён метод\tkiten shipped\n" +
      "совпало 0, изменено 0, конфликтов 0\n",
    ]);
    assertEquals(ran.refusals, []);
    assertEquals(await imageBytes(sync), before);
    assertEquals(await tree(sync.dir), {});
  }));

Deno.test("E10: messages — export обычным взглядом, sync через дверь", () =>
  withSync(async (sync) => {
    assertEquals(outcome(await sync.run("image messages")), [
      0,
      "export\tПишет в файлы каталога образа то, что изменилось в базе.\n",
    ]);
    assertEquals(outcome(await sync.run("ask image messages")), [
      0,
      "sync\tСводит методы образа с файлами каталога в обе стороны.\n",
    ]);
  }));

Deno.test("E11: посев — export allow, sync ask, пути image нет", () =>
  withSync(async (sync) => {
    const rules = JSON.parse((await sync.run("policy")).stdout) as {
      path: string;
      verdict: string;
    }[];
    assertEquals(
      rules.filter((rule) => rule.path.startsWith("image")),
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

Deno.test("Массовое удаление файлов: 3 из 5 — отказ, совет ведёт в image sync", async (t) => {
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
    await t.step(one.line, () =>
      withSync(async (sync) => {
        await sync.three();
        for (const line of TWO_MORE) {
          assertEquals((await sync.run(line)).exit, 0);
        }
        assertEquals((await sync.run("ask image sync")).exit, 0);
        for (const name of ["alpha", "beta", "cardsIn"]) {
          assertEquals((await sync.run(`ask kiten forget: ${name}`)).exit, 0);
        }
        const before = await snapshot(sync);
        const ran = await sync.run(one.line, {
          answers: [],
          cwd: `${sync.home}/mr/mp/mpu`,
        });
        assertEquals([ran.exit, ran.stdout, ran.stderr], [
          2,
          "",
          `${one.said}: удалилось бы 3 из 5 методов (файлы) — вызывай ` +
          `mpu ${one.hint.join(" ")}\n`,
        ]);
        assertEquals(ran.refusals.map((r) => [r.reason, r.hint]), [[
          "удалилось бы",
          one.hint,
        ]]);
        assertEquals(await snapshot(sync), before);
      }));
  }
});

Deno.test("журнал: строка image export — одна запись", () =>
  withSync(async (sync) => {
    await sync.three();
    const ran = await exported(sync);
    assertEquals([ran.exit, ran.native.length, ran.records], [0, 1, []]);
  }));

/** Голден справки (`image-export.md`, E5): пересобирает исполнитель. */
const HELP_GOLDEN = new URL(
  "./testdata/image-export/help.txt",
  import.meta.url,
);

Deno.test("голден testdata/image-export/help.txt — прогон на стенде", () =>
  withSync(async (sync) => {
    const ran = await sync.run("image export help");
    assertEquals(ran.exit, 0, ran.stderr);
    assertEquals(ran.stdout, await Deno.readTextFile(HELP_GOLDEN));
  }));
