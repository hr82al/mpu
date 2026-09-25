/**
 * `mpu ask image sync` (`image-sync.md`, «Сценарии»): образ и файлы
 * каталога сводятся в обе стороны по архиву. Стенд — `HOME` во временном
 * каталоге, `$H/mr/mp/mpu` создан заранее, Kaiten подменён.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Image, imageSyncCommand } from "../image/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { RuleBook } from "../policy/mod.ts";
import { registrySeeds } from "./seeds.ts";
import { imaging, withState } from "./testimage.ts";
import { type Ran, runOnStand, withStand } from "./testprogram.ts";

/** «Три метода» стенда — определены строками с ответом `y`. */
const THREE = [
  "ask kiten define: cardsIn purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
  "ask kiten define: mine purpose: ^мои^ do kiten ls done",
  "ask kiten define: shipped purpose: ^готово^ do kiten ls where: column is: Готово done",
];

/** Строка запуска без оговорок и её вопрос. */
const SYNC = "ask image sync";
const QUESTION = "выполнить mpu image sync? [y/N] ";

/** Файл `cardsIn:` — как в «Файл метода». */
const CARDS_IN_FILE =
  "kiten define: cardsIn: purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done\n";

const FIRST =
  "новый файл\tkiten cardsIn:\nновый файл\tkiten mine\nновый файл\tkiten shipped\n" +
  "совпало 0, изменено 3, конфликтов 0\n";

/** Что строке задают сверх слов. */
interface Asked {
  readonly answers?: readonly string[];
  readonly cwd?: string;
  readonly terminal?: boolean;
}

/** Стенд синхронизации. */
interface Sync {
  /** `HOME` стенда. */
  readonly home: string;
  /** Каталог образа по умолчанию, `$H/mr/mp/mpu/image`. */
  readonly dir: string;
  readonly policy: string;
  readonly imageFile: string;
  /** Строка словами через пробел или готовыми словами. */
  run(line: string | readonly string[], asked?: Asked): Promise<Ran>;
  /** «Три метода». */
  three(): Promise<void>;
  /** «Три метода» и один запуск с `y`. */
  synced(): Promise<void>;
}

function words(line: string): string[] {
  return line.split(" ");
}

async function withSync(body: (sync: Sync) => Promise<void>) {
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/mr/mp/mpu`, { recursive: true });
    await withState(({ policy, image: imageFile }) =>
      withStand(async (stand) => {
        const run = async (
          line: string | readonly string[],
          asked: Asked = {},
        ) => {
          // Образ открывается строкой заново: тест удаляет и портит файл.
          using image = Image.at(imageFile);
          const said = typeof line === "string" ? words(line) : line;
          return await runOnStand(policy, said, stand, {
            image: imaging(image),
            answers: asked.answers ?? ["y"],
            io: {
              env: (name) => name === "HOME" ? home : undefined,
              cwd: () => asked.cwd ?? "/stand",
              stdinIsTerminal: () => asked.terminal ?? true,
            },
          });
        };
        const three = async () => {
          for (const line of THREE) {
            const ran = await run(line);
            assertEquals(ran.exit, 0, ran.stderr);
          }
        };
        await body({
          home,
          dir: `${home}/mr/mp/mpu/image`,
          policy,
          imageFile,
          run,
          three,
          synced: async () => {
            await three();
            assertEquals((await run(SYNC)).stdout, FIRST);
          },
        });
      })
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

/** Файлы каталога: путь от него → текст. */
async function tree(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (sub: string) => {
    let entries;
    try {
      entries = await Array.fromAsync(Deno.readDir(`${dir}${sub}`));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    for (const entry of entries) {
      const path = `${sub}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else found[path.slice(1)] = await Deno.readTextFile(`${dir}${path}`);
    }
  };
  await walk("");
  return found;
}

function ruleOf(policy: string, path: string): string | null | undefined {
  using book = RuleBook.open(policy, registrySeeds());
  return book.list().find((rule) => rule.path === path)?.verdict;
}

Deno.test("1–2: три метода в пустой каталог, повтор — совпало 3, ничего не тронуто", () =>
  withSync(async (sync) => {
    await sync.three();
    const first = await sync.run(SYNC);
    assertEquals([first.exit, first.stdout, first.stderr], [
      0,
      FIRST,
      QUESTION,
    ]);
    const files = await tree(sync.dir);
    assertEquals(files["kiten/cardsIn:.mpu"], CARDS_IN_FILE);
    assertEquals(
      files["kiten/mine.mpu"],
      "kiten define: mine purpose: ^мои^ do kiten ls done\n",
    );
    const image = await Deno.readFile(sync.imageFile);
    const second = await sync.run(SYNC);
    assertEquals(
      [second.exit, second.stdout],
      [0, "совпало 3, изменено 0, конфликтов 0\n"],
    );
    assertEquals(await tree(sync.dir), files);
    assertEquals(await Deno.readFile(sync.imageFile), image);
  }));

Deno.test("3: правка назначения в файле — база из файла, автор human", () =>
  withSync(async (sync) => {
    await sync.synced();
    const path = `${sync.dir}/kiten/cardsIn:.mpu`;
    const text = await Deno.readTextFile(path);
    await Deno.writeTextFile(
      path,
      text.replace("^мои в колонке^", "^мои карточки^"),
    );
    const ran = await sync.run(SYNC);
    assertEquals(
      [ran.exit, ran.stdout],
      [
        0,
        "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
      ],
    );
    const help = await sync.run("kiten cardsIn: help");
    assert(help.stdout.includes("образ: мои карточки"), help.stdout);
    assert(help.stdout.includes("определён human"), help.stdout);
  }));

Deno.test("4: переопределение в базе — файл из базы", () =>
  withSync(async (sync) => {
    await sync.synced();
    await sync.run("ask kiten define: mine purpose: ^x^ do kiten ls done");
    const ran = await sync.run(SYNC);
    assertEquals(
      [ran.exit, ran.stdout],
      [0, "файл из базы\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n"],
    );
    assertEquals(
      await Deno.readTextFile(`${sync.dir}/kiten/mine.mpu`),
      "kiten define: mine purpose: ^x^ do kiten ls done\n",
    );
  }));

/** Итог строки: код, stdout — для сверки одной записью. */
function outcome(ran: Ran): [number, string] {
  return [ran.exit, ran.stdout];
}

/** Файлы и образ побайтово: «ничего не изменено». */
async function snapshot(sync: Sync): Promise<unknown> {
  return {
    files: await tree(sync.dir),
    image: await Deno.readFile(sync.imageFile),
  };
}

/** Конфликт сценария 5: назначение изменено и в файле, и в базе. */
async function conflicted(sync: Sync) {
  await sync.synced();
  const path = `${sync.dir}/kiten/cardsIn:.mpu`;
  await Deno.writeTextFile(
    path,
    CARDS_IN_FILE.replace("^мои в колонке^", "^мои карточки^"),
  );
  const redefined = await sync.run(
    "ask kiten define: cardsIn purpose: ^x^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
  );
  assertEquals(redefined.exit, 0, redefined.stderr);
}

Deno.test("5: изменено с обеих сторон — конфликт с адресом, стороны прежние", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const before = await snapshot(sync);
    assertEquals(outcome(await sync.run(SYNC)), [
      1,
      "конфликт\tkiten cardsIn:\tkiten.cardsIn\nсовпало 2, изменено 0, конфликтов 1\n",
    ]);
    assertEquals(await snapshot(sync), before);
  }));

Deno.test("6: files: решает конфликт — база из файла", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const ran = await sync.run("ask image sync files: kiten.cardsIn");
    assertEquals(
      ran.stderr,
      "выполнить mpu image sync files: kiten.cardsIn? [y/N] ",
    );
    assertEquals(outcome(ran), [
      0,
      "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
  }));

Deno.test("7: image.db удалена — новый метод из каждого файла, посев правила", () =>
  withSync(async (sync) => {
    await sync.synced();
    await Deno.remove(sync.imageFile);
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "новый метод\tkiten cardsIn:\nновый метод\tkiten mine\nновый метод\tkiten shipped\n" +
      "совпало 0, изменено 3, конфликтов 0\n",
    ]);
    assertEquals(ruleOf(sync.policy, "kiten cardsIn:"), "allow");
    // Повтор после записи файл → база: хэш архива — хэш метода базы.
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

Deno.test("8–9: каталог очищен — отказ массового удаления; deletes: allow — удалён метод", () =>
  withSync(async (sync) => {
    await sync.synced();
    await Deno.remove(sync.dir, { recursive: true });
    const before = await Deno.readFile(sync.imageFile);
    const refused = await sync.run(SYNC);
    assertEquals(
      [refused.exit, refused.stdout, refused.stderr],
      [
        2,
        "",
        QUESTION +
        "mpu image sync: удалилось бы 3 из 3 методов (база) — вызывай mpu ask image sync deletes: allow\n",
      ],
    );
    assertEquals(refused.refusals.map((one) => [one.reason, one.hint]), [[
      "удалилось бы",
      ["ask", "image", "sync", "deletes:", "allow"],
    ]]);
    assertEquals(await Deno.readFile(sync.imageFile), before);
    assertEquals(outcome(await sync.run("ask image sync deletes: allow")), [
      0,
      "удалён метод\tkiten cardsIn:\nудалён метод\tkiten mine\nудалён метод\tkiten shipped\n" +
      "совпало 0, изменено 3, конфликтов 0\n",
    ]);
    for (const path of ["kiten cardsIn:", "kiten mine", "kiten shipped"]) {
      assertEquals(ruleOf(sync.policy, path), undefined, path);
    }
  }));

Deno.test("10, 46: удалён с обеих сторон — строка архива снимается молча; dry её не снимает", () =>
  withSync(async (sync) => {
    await sync.synced();
    assertEquals((await sync.run("ask kiten forget: cardsIn")).exit, 0);
    await Deno.remove(`${sync.dir}/kiten/cardsIn:.mpu`);
    const quiet = [0, "совпало 2, изменено 0, конфликтов 0\n"];
    const archived = () => {
      using image = Image.at(sync.imageFile);
      return image.archive(sync.dir).has("kiten cardsIn:");
    };
    assertEquals(outcome(await sync.run("ask image sync dry")), quiet);
    assertEquals(archived(), true);
    assertEquals(outcome(await sync.run(SYNC)), quiet);
    assertEquals(archived(), false);
    assertEquals(outcome(await sync.run(SYNC)), quiet);
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
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  if (typeof text === "string") await Deno.writeTextFile(full, text);
  else await Deno.writeFile(full, text);
}

Deno.test("11, 12, 43, 53, 55: неразобранный файл — строка отчёта, код 1, метод не тронут", async (t) => {
  for (const [name, path, reason] of UNREAD) {
    await t.step(name, () =>
      withSync(async (sync) => {
        await sync.synced();
        await put(sync.dir, path, UNREAD_TEXT[path]);
        assertEquals(outcome(await sync.run(SYNC)), [
          1,
          `файл не разобран\t${path}\t${reason}\nсовпало 3, изменено 0, конфликтов 0\n`,
        ]);
      }));
  }
});

Deno.test("57: чужие файлы каталога не читаются и не удаляются", () =>
  withSync(async (sync) => {
    await sync.synced();
    await put(sync.dir, "kiten/notes.txt", "заметки");
    await put(sync.dir, "kiten/.cardsIn:.mpu.swp", "мусор");
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
    const files = await tree(sync.dir);
    assertEquals(files["kiten/notes.txt"], "заметки");
    assertEquals(files["kiten/.cardsIn:.mpu.swp"], "мусор");
  }));

const PING_ALL =
  "kiten define: pingAll purpose: ^пинг^ do kiten ls each: do :c kiten comment id: @c id text: ping done done";

Deno.test("13: база пуста, метод из файла, достигающий записи, — новый метод, правило ask", () =>
  withSync(async (sync) => {
    await put(sync.dir, "kiten/pingAll.mpu", PING_ALL);
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "новый метод\tkiten pingAll\nсовпало 0, изменено 1, конфликтов 0\n",
    ]);
    assertEquals(ruleOf(sync.policy, "kiten pingAll"), "ask");
    const help = await sync.run("kiten pingAll help");
    assert(help.stdout.includes("определён human"), help.stdout);
  }));

Deno.test("14: метод зовёт метод этого же запуска — правила allow в обоих порядках файлов", async (t) => {
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
    await t.step(order.join(" → "), () =>
      withSync(async (sync) => {
        for (const path of order) await put(sync.dir, path, files[path]);
        assertEquals(outcome(await sync.run(SYNC)), [
          0,
          "новый метод\tkiten a\nновый метод\tkiten b\nсовпало 0, изменено 2, конфликтов 0\n",
        ]);
        assertEquals(ruleOf(sync.policy, "kiten a"), "allow");
        assertEquals(ruleOf(sync.policy, "kiten b"), "allow");
        assertEquals(outcome(await sync.run(SYNC)), [
          0,
          "совпало 2, изменено 0, конфликтов 0\n",
        ]);
      }));
  }
});

Deno.test("15: каталог без права записи — сбой по методу, архив прежний; после chmod — как 1", () =>
  withSync(async (sync) => {
    await sync.three();
    await Deno.mkdir(`${sync.dir}/kiten`, { recursive: true });
    await Deno.chmod(`${sync.dir}/kiten`, 0o555);
    const ran = await sync.run(SYNC);
    const lines = ran.stdout.split("\n");
    assertEquals(ran.exit, 1);
    assertEquals(
      lines.map((line) => line.split("\t").slice(0, 2).join("\t")),
      [
        "сбой\tkiten cardsIn:",
        "сбой\tkiten mine",
        "сбой\tkiten shipped",
        "совпало 0, изменено 0, конфликтов 0",
        "",
      ],
    );
    assert(lines[0].split("\t")[2].length > 0, lines[0]);
    await Deno.chmod(`${sync.dir}/kiten`, 0o755);
    assertEquals(outcome(await sync.run(SYNC)), [0, FIRST]);
  }));

Deno.test("16–17: каталог вне права — отказ до вопроса, код 2", () =>
  withSync(async (sync) => {
    const tail = ` — каталог образа только под ${sync.dir}\n`;
    const given = await sync.run("ask image sync dir: /tmp/x");
    assertEquals(
      [given.exit, given.stdout, given.stderr],
      [2, "", `mpu image sync dir: /tmp/x: нет права записи в /tmp/x${tail}`],
    );
    const set = await sync.run("ask config key: image.dir value: /tmp/x");
    assertEquals(set.exit, 0, set.stderr);
    const keyed = await sync.run(SYNC);
    assertEquals(
      [keyed.exit, keyed.stdout, keyed.stderr],
      [2, "", `mpu image sync: нет права записи в /tmp/x${tail}`],
    );
  }));

Deno.test("18, 48: другой каталог — свой архив; вложенный каталог образа — неразобранные файлы", () =>
  withSync(async (sync) => {
    await sync.synced();
    const other = `${sync.dir}/other`;
    const set = await sync.run(
      `ask config key: image.dir value: ${other}`,
    );
    assertEquals(set.exit, 0, set.stderr);
    assertEquals(outcome(await sync.run(SYNC)), [0, FIRST]);
    assertEquals(
      (await tree(other))["kiten/cardsIn:.mpu"],
      CARDS_IN_FILE,
    );
    assertEquals((await sync.run("ask config unset key: image.dir")).exit, 0);
    const refusal =
      "mpu other kiten define: метод — только у команды или группы";
    assertEquals(outcome(await sync.run(SYNC)), [
      1,
      ["cardsIn:", "mine", "shipped"].map((name) =>
        `файл не разобран\tother/kiten/${name}.mpu\t${refusal}\n`
      ).join("") + "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

Deno.test("19: относительный dir: — от cwd строки", () =>
  withSync(async (sync) => {
    await sync.three();
    const ran = await sync.run("ask image sync dir: image", {
      cwd: `${sync.home}/mr/mp/mpu`,
    });
    assertEquals(outcome(ran), [0, FIRST]);
    assertEquals((await tree(sync.dir))["kiten/cardsIn:.mpu"], CARDS_IN_FILE);
  }));

Deno.test("20: dry — тот же stdout, ничего не изменено; повтор без dry — тот же stdout", () =>
  withSync(async (sync) => {
    await sync.synced();
    const path = `${sync.dir}/kiten/cardsIn:.mpu`;
    await Deno.writeTextFile(
      path,
      CARDS_IN_FILE.replace("^мои в колонке^", "^мои карточки^"),
    );
    const before = await snapshot(sync);
    const expected =
      "база из файла\tkiten cardsIn:\nсовпало 2, изменено 1, конфликтов 0\n";
    const dry = await sync.run("ask image sync dry");
    assertEquals(
      [dry.exit, dry.stdout, dry.stderr],
      [0, expected, "выполнить mpu image sync dry? [y/N] "],
    );
    assertEquals(await snapshot(sync), before);
    assertEquals(outcome(await sync.run(SYNC)), [0, expected]);
  }));

Deno.test("21–22: без ask — адресный отказ двери", async (t) => {
  for (const line of ["image sync dry", "image sync"]) {
    await t.step(line, () =>
      withSync(async (sync) => {
        const ran = await sync.run(line);
        assertEquals(
          [ran.exit, ran.stdout, ran.stderr],
          [
            2,
            "",
            `mpu ${line}: требует подтверждения — вызывай mpu ask ${line}\n`,
          ],
        );
      }));
  }
});

Deno.test("23: ответ n — не подтверждено, ничего не изменено", () =>
  withSync(async (sync) => {
    await conflicted(sync);
    const before = await snapshot(sync);
    const ran = await sync.run(SYNC, { answers: ["n"] });
    assertEquals(
      [ran.exit, ran.stdout, ran.stderr],
      [1, "", `${QUESTION}mpu image sync: не подтверждено\n`],
    );
    assertEquals(await snapshot(sync), before);
  }));

Deno.test("31, 33, 53: справка, messages группы и корня через дверь", () =>
  withSync(async (sync) => {
    const help = await sync.run("image sync help");
    assertEquals(help.exit, 0);
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
    // Обычный взгляд: `sync` посеян `ask` — перечислять нечего.
    assertEquals(outcome(await sync.run("image messages")), [0, ""]);
    const messages = await sync.run("ask image messages");
    assertEquals(outcome(messages), [
      0,
      "sync\tСводит методы образа с файлами каталога в обе стороны.\n",
    ]);
    const root = (await sync.run("ask messages")).stdout.split("\n");
    const at = root.indexOf("image\tметоды образа и файлы каталога");
    assert(at > 0, root.join("\n"));
    assert(root[at - 1] < "image", root[at - 1]);
    assert(root[at + 1].startsWith("init\t"), root[at + 1]);
    // Обычный взгляд группы без исполнимых без `ask` детей не называет.
    const plain = (await sync.run("messages")).stdout;
    assert(!plain.includes("image\t"), plain);
  }));

Deno.test("34–35: мусор вместо файла не удаляет метод и не входит в счёт удалений", () =>
  withSync(async (sync) => {
    await sync.synced();
    await Deno.writeTextFile(`${sync.dir}/kiten/cardsIn:.mpu`, "мусор");
    const before = await Deno.readFile(sync.imageFile);
    assertEquals(outcome(await sync.run(SYNC)), [
      1,
      "файл не разобран\tkiten/cardsIn:.mpu\tв файле нет строки определения\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    assertEquals(await Deno.readFile(sync.imageFile), before);
    assertEquals(ruleOf(sync.policy, "kiten cardsIn:"), "allow");
    await Deno.remove(`${sync.dir}/kiten/mine.mpu`);
    await Deno.remove(`${sync.dir}/kiten/shipped.mpu`);
    const refused = await sync.run(SYNC);
    assertEquals(
      [refused.exit, refused.stdout, refused.stderr],
      [
        2,
        "",
        QUESTION +
        "mpu image sync: удалилось бы 2 из 3 методов (база) — вызывай mpu ask image sync deletes: allow\n",
      ],
    );
  }));

Deno.test("36: define: получателя deny — сбой, база и архив пусты", () =>
  withSync(async (sync) => {
    const denied = await sync.run(["deny:", "--", "kiten define:"]);
    assertEquals(denied.exit, 0, denied.stderr);
    await put(sync.dir, "kiten/pingAll.mpu", PING_ALL);
    assertEquals(outcome(await sync.run(SYNC)), [
      1,
      "сбой\tkiten pingAll\tзапрещено правилом «kiten define:»\n" +
      "совпало 0, изменено 0, конфликтов 0\n",
    ]);
    assertEquals(ruleOf(sync.policy, "kiten pingAll"), undefined);
    using image = Image.at(sync.imageFile);
    assertEquals(image.methods().length, 0);
    assertEquals(image.archive(sync.dir).size, 0);
  }));

Deno.test("37: forget: получателя deny — сбой, метод в базе", () =>
  withSync(async (sync) => {
    await sync.synced();
    const denied = await sync.run(["deny:", "--", "kiten forget:"]);
    assertEquals(denied.exit, 0, denied.stderr);
    await Deno.remove(`${sync.dir}/kiten/mine.mpu`);
    assertEquals(outcome(await sync.run(SYNC)), [
      1,
      "сбой\tkiten mine\tзапрещено правилом «kiten forget:»\n" +
      "совпало 2, изменено 0, конфликтов 0\n",
    ]);
    assertEquals(ruleOf(sync.policy, "kiten mine"), "allow");
  }));

Deno.test("41: BOM и \\r\\n — те же слова, файл не переписан", () =>
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
    await Deno.writeFile(`${sync.dir}/kiten/mine.mpu`, bytes);
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
    assertEquals(await Deno.readFile(`${sync.dir}/kiten/mine.mpu`), bytes);
  }));

Deno.test("42: неразрывный пробел — часть слова, повтор совпадает", () =>
  withSync(async (sync) => {
    await sync.three();
    const defined = await sync.run(
      "ask kiten define: nb purpose: ^a b^ do kiten ls done",
    );
    assertEquals(defined.exit, 0, defined.stderr);
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "новый файл\tkiten cardsIn:\nновый файл\tkiten mine\nновый файл\tkiten nb\n" +
      "новый файл\tkiten shipped\nсовпало 0, изменено 4, конфликтов 0\n",
    ]);
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "совпало 4, изменено 0, конфликтов 0\n",
    ]);
    assert(
      (await Deno.readTextFile(`${sync.dir}/kiten/nb.mpu`)).includes(
        "^a b^",
      ),
    );
  }));

Deno.test("44: имя файла без двоеточия — не тот метод", () =>
  withSync(async (sync) => {
    await sync.synced();
    await Deno.copyFile(
      `${sync.dir}/kiten/cardsIn:.mpu`,
      `${sync.dir}/kiten/cardsIn.mpu`,
    );
    assertEquals(outcome(await sync.run(SYNC)), [
      1,
      "файл не разобран\tkiten/cardsIn.mpu\tв файле kiten cardsIn:, ждали kiten cardsIn\n" +
      "совпало 3, изменено 0, конфликтов 0\n",
    ]);
  }));

Deno.test("45: forget: в базе — удалён файл", () =>
  withSync(async (sync) => {
    await sync.synced();
    assertEquals((await sync.run("ask kiten forget: mine")).exit, 0);
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "удалён файл\tkiten mine\nсовпало 2, изменено 1, конфликтов 0\n",
    ]);
    assertEquals((await tree(sync.dir))["kiten/mine.mpu"], undefined);
  }));

Deno.test("49: посев image sync — ask, пути image нет", () =>
  withSync(async (sync) => {
    const rules = JSON.parse((await sync.run("policy")).stdout) as {
      path: string;
      verdict: string;
    }[];
    assertEquals(
      rules.filter((rule) => rule.path === "image sync"),
      [{ path: "image sync", verdict: "ask" }],
    );
    assertEquals(rules.filter((rule) => rule.path === "image"), []);
  }));

/** Файл метода стенда: путь от каталога. */
function fileOf(sync: Sync, name: string): string {
  return `${sync.dir}/kiten/${name}.mpu`;
}

/** Назначение изменено в файле метода `name`. */
async function editFile(sync: Sync, name: string) {
  const path = fileOf(sync, name);
  const text = await Deno.readTextFile(path);
  await Deno.writeTextFile(path, text.replace(/\^[^^]*\^/, "^из файла^"));
}

/** Метод `name` переопределён в базе с новым назначением. */
async function redefine(sync: Sync, name: string, body = "do kiten ls done") {
  const ran = await sync.run(
    `ask kiten define: ${name} purpose: ^из базы^ ${body}`,
  );
  assertEquals(ran.exit, 0, ran.stderr);
}

Deno.test("Конфликт на этот запуск: base:/files: выбирают сторону", async (t) => {
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
        await Deno.remove(fileOf(sync, "mine"));
      },
      "ask image sync files: kiten.mine",
      "удалён метод\tkiten mine\n" + summary(1, 0),
    ],
    [
      "изменён в базе, удалён в файле; base: — файл из базы",
      async (sync) => {
        await redefine(sync, "mine");
        await Deno.remove(fileOf(sync, "mine"));
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
    await t.step(name, () =>
      withSync(async (sync) => {
        await sync.synced();
        await given(sync);
        assertEquals(outcome(await sync.run(line)), [exit, expected]);
      }));
  }
});

Deno.test("Конфликт: kiten.mine называет и mine, и mine:", () =>
  withSync(async (sync) => {
    await sync.three();
    const keyed = await sync.run(
      "ask kiten define: mine: purpose: ^m^ do :x kiten ls done",
    );
    assertEquals(keyed.exit, 0, keyed.stderr);
    assertEquals((await sync.run(SYNC)).exit, 0);
    await editFile(sync, "mine");
    await editFile(sync, "mine:");
    await redefine(sync, "mine");
    await redefine(sync, "mine:", "do :x kiten ls done");
    assertEquals(outcome(await sync.run("ask image sync files: kiten.mine")), [
      0,
      "база из файла\tkiten mine\nбаза из файла\tkiten mine:\n" +
      "совпало 2, изменено 2, конфликтов 0\n",
    ]);
  }));

Deno.test("Конфликт: неверный адрес — отказ до вопроса, код 2", async (t) => {
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
    await t.step(line, () =>
      withSync(async (sync) => {
        await sync.synced();
        const ran = await sync.run(line);
        assertEquals([ran.exit, ran.stdout, ran.stderr], [2, "", stderr]);
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
    assertEquals((await sync.run(numbered(n))).exit, 0);
  }
  assertEquals((await sync.run(SYNC)).exit, 0);
}

/** Удалены файлы методов `m1…m<count>`: столько удалений в базе. */
async function removeFiles(sync: Sync, count: number) {
  for (let n = 1; n <= count; n++) await Deno.remove(fileOf(sync, `m${n}`));
}

Deno.test("Предохранители: N из M удалений стороны", async (t) => {
  const passes: readonly (readonly [number, number])[] = [[1, 3], [1, 2], [
    2,
    4,
  ]];
  for (const [deleted, of] of passes) {
    await t.step(
      `${deleted} из ${of} — проходит`,
      () =>
        withSync(async (sync) => {
          await syncedMany(sync, of);
          await removeFiles(sync, deleted);
          const ran = await sync.run(SYNC);
          assertEquals(ran.exit, 0, ran.stderr);
          assert(ran.stdout.includes(`изменено ${deleted},`), ran.stdout);
        }),
    );
  }
  const refused: readonly (readonly [number, number])[] = [[2, 3], [3, 5]];
  for (const [deleted, of] of refused) {
    await t.step(`${deleted} из ${of} — отказ`, () =>
      withSync(async (sync) => {
        await syncedMany(sync, of);
        await removeFiles(sync, deleted);
        const ran = await sync.run(SYNC);
        assertEquals(
          [ran.exit, ran.stdout, ran.stderr],
          [
            2,
            "",
            QUESTION +
            `mpu image sync: удалилось бы ${deleted} из ${of} методов (база) — вызывай mpu ask image sync deletes: allow\n`,
          ],
        );
      }));
  }
  await t.step("1 из 1 (файлы) — отказ", () =>
    withSync(async (sync) => {
      await syncedMany(sync, 1);
      assertEquals((await sync.run("ask kiten forget: m1")).exit, 0);
      const ran = await sync.run(SYNC);
      assertEquals(
        [ran.exit, ran.stderr],
        [
          2,
          QUESTION +
          "mpu image sync: удалилось бы 1 из 1 методов (файлы) — вызывай mpu ask image sync deletes: allow\n",
        ],
      );
    }));
  await t.step(
    "10 из 10, deletes: allow — проходит",
    () =>
      withSync(async (sync) => {
        await syncedMany(sync, 10);
        await removeFiles(sync, 10);
        const ran = await sync.run("ask image sync deletes: allow");
        assertEquals(ran.exit, 0, ran.stderr);
        assertEquals(
          ran.stdout.split("\n").filter((line) =>
            line.startsWith("удалён метод")
          )
            .length,
          10,
        );
      }),
  );
  await t.step(
    "база 1 из 2 и файлы 1 из 2 — проходит",
    () =>
      withSync(async (sync) => {
        // База {m1, m2}, файлы {m2, m3}: у каждой стороны 1 из 2.
        await syncedMany(sync, 3);
        await removeFiles(sync, 1);
        assertEquals((await sync.run("ask kiten forget: m3")).exit, 0);
        assertEquals(outcome(await sync.run(SYNC)), [
          0,
          "удалён метод\tkiten m1\nудалён файл\tkiten m3\n" +
          "совпало 1, изменено 2, конфликтов 0\n",
        ]);
      }),
  );
  await t.step(
    "dry, 3 из 5 — тот же отказ, в совете dry",
    () =>
      withSync(async (sync) => {
        await syncedMany(sync, 5);
        await removeFiles(sync, 3);
        const ran = await sync.run("ask image sync dry");
        assertEquals(
          [ran.exit, ran.stdout, ran.stderr],
          [
            2,
            "",
            "выполнить mpu image sync dry? [y/N] " +
            "mpu image sync dry: удалилось бы 3 из 5 методов (база) — вызывай mpu ask image sync dry deletes: allow\n",
          ],
        );
        assertEquals(ran.refusals.map((one) => one.hint), [[
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

Deno.test("Файл метода: получатель из двух звеньев — вложенный каталог", () =>
  withSync(async (sync) => {
    const defined = await sync.run(
      "ask kiten ls define: inColumn purpose: ^колонка^ do :c kiten ls where: column is: @c done",
    );
    assertEquals(defined.exit, 0, defined.stderr);
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "новый файл\tkiten ls inColumn:\nсовпало 0, изменено 1, конфликтов 0\n",
    ]);
    assertEquals(
      (await tree(sync.dir))["kiten/ls/inColumn:.mpu"],
      "kiten ls define: inColumn: purpose: ^колонка^ do :c kiten ls where: column is: @c done\n",
    );
  }));

Deno.test("Результат — текст: end json — отказ до исполнения; deletes: не allow — отказ реестра", () =>
  withSync(async (sync) => {
    await sync.three();
    const json = await sync.run("ask image sync end json");
    assertEquals(
      [json.exit, json.stdout, json.stderr],
      [2, "", "mpu ask image sync end: не понимает json\n"],
    );
    assertEquals(await tree(sync.dir), {});
    const deletes = await sync.run("ask image sync deletes: yes");
    assertEquals([deletes.exit, deletes.stdout], [2, ""]);
    assertEquals(
      deletes.stderr,
      'mpu image sync: invalid deletes: value "yes"; ' +
        "попробуй: mpu image sync --help\n",
    );
  }));

Deno.test("журнал: строка image sync — одна запись, и у исполненной, и у отказа до вопроса", () =>
  withSync(async (sync) => {
    await sync.three();
    for (const line of [SYNC, "ask image sync dir: /tmp/x"]) {
      const ran = await sync.run(line);
      assertEquals([ran.native.length, ran.records], [1, []], line);
    }
  }));

/** Голдены справки группы `image` (`image-sync.md`, «Сценарии»). */
const GOLDENS = new URL("./testdata/image-sync/", import.meta.url);

Deno.test("голдены testdata/image-sync: справка и messages — прогон на стенде", async (t) => {
  const lines: readonly (readonly [string, string])[] = [
    ["help.txt", "image sync help"],
    ["messages.txt", "ask image messages"],
  ];
  for (const [name, line] of lines) {
    await t.step(name, () =>
      withSync(async (sync) => {
        const ran = await sync.run(line);
        assertEquals(ran.exit, 0, ran.stderr);
        assertEquals(
          ran.stdout,
          await Deno.readTextFile(new URL(name, GOLDENS)),
        );
      }));
  }
});

Deno.test("команда реестра image sync вне ядра не исполняется", async () => {
  await assertRejects(
    () => imageSyncCommand.invoke([], makeFakeIo()),
    Error,
    "строку image sync исполняет ядро",
  );
});

Deno.test("отчёт: по получателю, затем по имени — не по склейке", () =>
  withSync(async (sync) => {
    for (
      const line of [
        "ask kiten define: mine purpose: ^мои^ do kiten ls done",
        "ask kiten ls define: inColumn purpose: ^к^ do :c kiten ls where: column is: @c done",
      ]
    ) {
      assertEquals((await sync.run(line)).exit, 0);
    }
    assertEquals(outcome(await sync.run(SYNC)), [
      0,
      "новый файл\tkiten mine\nновый файл\tkiten ls inColumn:\n" +
      "совпало 0, изменено 2, конфликтов 0\n",
    ]);
  }));
