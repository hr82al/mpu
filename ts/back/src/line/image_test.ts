/**
 * Методы образа через ядро строки (`platform/image.md`, «Граничные
 * случаи»): определение, вызов, отражение, удаление, чужой процесс,
 * мусор вместо файла. Kaiten подменён (`testprogram.ts`), правила и образ
 * — во временном каталоге.
 */

import { assert, assertEquals } from "@std/assert";
import { Image } from "../image/mod.ts";
import { ALLOW, DENY, RuleBook, RulePath } from "../policy/mod.ts";
import { type ImagePorts, registryNodes } from "./mod.ts";
import { registrySeeds } from "./seeds.ts";
import {
  CARDS_IN,
  IMAGE_DIR,
  imageGoldens,
  imaging,
  withState,
} from "./testimage.ts";
import { type Ran, runOnStand, type Stand, withStand } from "./testprogram.ts";

const PING_ALL =
  "ask kiten define: pingAll purpose: ^пинг^ do kiten ls each: do :c kiten comment id: @c id text: ping done done";

function words(line: string): string[] {
  return line.split(" ");
}

/** Строка на стенде с образом `image`. */
function lineOn(
  stand: Stand,
  policy: string,
  image: ImagePorts,
  line: string,
  answers: readonly string[] = [],
): Promise<Ran> {
  return runOnStand(policy, words(line), stand, { image, answers });
}

function ruleOf(policy: string, path: string): string | null | undefined {
  using book = RuleBook.open(policy, registrySeeds());
  return book.list().find((rule) => rule.path === path)?.verdict;
}

Deno.test("define: с «да» — метод записан, правило посева allow, вызов — число", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const changes: string[] = [];
      const ports = imaging(image, changes);
      const defined = await lineOn(stand, policy, ports, CARDS_IN, ["y"]);
      assertEquals(defined.exit, 0);
      assertEquals(
        defined.stdout,
        '{"path":"kiten cardsIn:","verdict":"allow"}\n',
      );
      assertEquals(
        defined.stderr,
        `выполнить mpu ${CARDS_IN.slice(4)}? [y/N] `,
      );
      assertEquals(changes, ["changed"]);
      assertEquals(ruleOf(policy, "kiten cardsIn:"), "allow");
      const called = await lineOn(
        stand,
        policy,
        ports,
        "kiten cardsIn: 9101 end size",
      );
      assertEquals([called.exit, called.stdout, called.stderr], [0, "2\n", ""]);
      // Журнал: вызов метода своей записью, затем команда тела.
      assertEquals(called.records.map((record) => record.argv.join(" ")), [
        "kiten cardsIn: 9101",
        "kiten ls",
      ]);
    })
  ));

Deno.test("метод отвечает протоколу: messages, understands:, help, complete:, снимок", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ports = imaging(image);
      await lineOn(stand, policy, ports, CARDS_IN, ["y"]);
      const messages = await lineOn(stand, policy, ports, "kiten messages");
      assert(
        messages.stdout.includes("\ncardsIn:\tобраз: мои в колонке\n"),
        messages.stdout,
      );
      const understands = await lineOn(
        stand,
        policy,
        ports,
        "kiten understands: -- cardsIn:",
      );
      assertEquals(understands.stdout, "true\n");
      const help = await lineOn(stand, policy, ports, "kiten cardsIn: help");
      assertEquals(help.exit, 0);
      assertEquals(help.stdout.split("\n\n"), [
        "Использование: mpu kiten cardsIn: <сообщение>",
        "образ: мои в колонке",
        "Метод образа, определён human 2026-09-23T10:00:00.000Z.\n" +
        "Исходник: do :col kiten ls where: column is: @col done",
        "Ключи:\n  cardsIn:  id колонки (обязательный)\n",
      ]);
      const complete = await runOnStand(
        policy,
        ["complete:", "kiten ca"],
        stand,
        { image: ports },
      );
      assertEquals(
        complete.stdout.split("\n").map((row) => row.split("\t")[0]),
        [
          "card",
          "cardsIn:",
          "",
        ],
      );
      const node = registryNodes(image.methods())
        .find((one) => one.path.join(" ") === "kiten cardsIn:");
      assertEquals(node?.image, {
        author: "human",
        time: "2026-09-23T10:00:00.000Z",
        source: "do :col kiten ls where: column is: @col done",
      });
    })
  ));

Deno.test("голдены testdata/image: прогон на стенде совпадает", async () => {
  const taken = await imageGoldens();
  for (const [name, text] of Object.entries(taken)) {
    const kept = await Deno.readTextFile(new URL(name, IMAGE_DIR));
    assertEquals(text, kept, name);
  }
});

/** Отказ определения до записи: код 2, образ пуст, правила нет. */
const MISDEFINED: readonly (readonly [string, string])[] = [
  [
    "ask kiten define: cardsIn do :c kiten ls done",
    "mpu kiten define: метод без назначения: purpose: ^…^\n",
  ],
  [
    "ask kiten define: ls purpose: ^x^ do kiten ls done",
    "mpu kiten define: ls у kiten уже есть\n",
  ],
  [
    "ask kiten ls define: column purpose: ^x^ do :a kiten ls done",
    "mpu kiten ls define: column: у kiten ls уже есть\n",
  ],
  [
    "ask kiten ls define: column:foo purpose: ^x^ do :a :b kiten ls done",
    "mpu kiten ls define: имя делится на column: и foo: — выбери другое\n",
  ],
  [
    "ask kiten define: two:parts purpose: ^x^ do :a kiten ls done",
    "mpu kiten define: имя two:parts: ждёт 2 параметра, у блока 1\n",
  ],
  [
    "ask kiten define: y purpose: ^x^ kiten ls",
    "выражение 1: тело метода — блок do … done\n",
  ],
  [
    "ask nothing define: y purpose: ^x^ do kiten ls done",
    "mpu nothing define: метод — только у команды или группы\n",
  ],
  [
    "ask kiten define: 1x purpose: ^x^ do kiten ls done",
    "mpu kiten define: имя метода — слово: 1x\n",
  ],
  [
    "ask kiten define: y purpose: ^не закрыт do kiten ls done",
    "mpu kiten define: purpose: текст не закрыт\n",
  ],
  [
    "ask kiten define: y: purpose: ^x^ do :c kiten card id: c done",
    "выражение 1, блок: переменная в значении — @c; текст — -- c\n",
  ],
  [
    "kiten define: z purpose: ^x^ do :c kiten ls done",
    "mpu kiten define: z purpose: ^x^ do :c kiten ls done: требует " +
    "подтверждения — вызывай mpu ask kiten define: z purpose: ^x^ do :c " +
    "kiten ls done\n",
  ],
];

Deno.test("отказы определения — код 2, ничего не записано", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ports = imaging(image);
      for (const [line, stderr] of MISDEFINED) {
        const ran = await lineOn(stand, policy, ports, line, ["y"]);
        assertEquals([ran.exit, ran.stderr, ran.stdout], [2, stderr, ""], line);
      }
      assertEquals(image.methods(), []);
    })
  ));

Deno.test("метод, достигающий записи: посев ask; без ask — отказ; вопрос на каждый вызов", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ports = imaging(image);
      const defined = await lineOn(stand, policy, ports, PING_ALL, ["y"]);
      assertEquals(
        defined.stdout,
        '{"path":"kiten pingAll","verdict":"ask"}\n',
      );
      assertEquals(ruleOf(policy, "kiten pingAll"), "ask");
      const bare = await lineOn(stand, policy, ports, "kiten pingAll");
      assertEquals([bare.exit, bare.stderr], [
        2,
        "mpu kiten pingAll: строка может записать (kiten pingAll) — начни с " +
        "ask: mpu ask kiten pingAll\n",
      ]);
      assertEquals(stand.asked(), 0);
      const no = await lineOn(stand, policy, ports, "ask kiten pingAll", ["n"]);
      assertEquals([no.exit, no.stderr], [
        1,
        "выполнить mpu kiten pingAll? [y/N] mpu kiten pingAll: не подтверждено\n",
      ]);
      assertEquals(stand.asked(), 0);
      const twice = await lineOn(
        stand,
        policy,
        ports,
        "ask 1 to: 2 do: do :i kiten pingAll done",
        ["y", "y", "y", "y", "n"],
      );
      assertEquals(twice.exit, 1);
      assertEquals(
        twice.stderr.split("? [y/N] ").slice(0, 5),
        [
          "выполнить mpu kiten pingAll",
          "выполнить mpu kiten comment id: 11 text: ping",
          "выполнить mpu kiten comment id: 12 text: ping",
          "выполнить mpu kiten comment id: 13 text: ping",
          "выполнить mpu kiten pingAll",
        ],
      );
      assertEquals(stand.posted(), ["11 ping", "12 ping", "13 ping"]);
    })
  ));

Deno.test("метод, определённый другим процессом, виден следующей строке", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using mine = Image.at(file);
      using other = Image.at(file);
      await lineOn(stand, policy, imaging(other), CARDS_IN, ["y"]);
      const first = await lineOn(
        stand,
        policy,
        imaging(mine),
        "kiten cardsIn: 9101 end size",
      );
      assertEquals(first.stdout, "2\n");
      await lineOn(
        stand,
        policy,
        imaging(other),
        "ask kiten define: every purpose: ^все^ do kiten ls done",
        ["y"],
      );
      const second = await lineOn(
        stand,
        policy,
        imaging(mine),
        "kiten every size",
      );
      assertEquals([second.exit, second.stdout], [0, "3\n"]);
    })
  ));

Deno.test("forget: — метод исчез из отражения, дополнения, снимка и правил", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const changes: string[] = [];
      const ports = imaging(image, changes);
      await lineOn(stand, policy, ports, CARDS_IN, ["y"]);
      const forgot = await lineOn(
        stand,
        policy,
        ports,
        "ask kiten forget: cardsIn",
        ["y"],
      );
      assertEquals(forgot.stdout, '{"path":"kiten cardsIn:","verdict":null}\n');
      assertEquals(changes, ["changed", "changed"]);
      assertEquals(ruleOf(policy, "kiten cardsIn:"), undefined);
      const messages = await lineOn(stand, policy, ports, "kiten messages");
      assert(!messages.stdout.includes("cardsIn:"), messages.stdout);
      const complete = await runOnStand(
        policy,
        ["complete:", "kiten ca"],
        stand,
        { image: ports },
      );
      assert(!complete.stdout.includes("cardsIn:"), complete.stdout);
      assert(
        !registryNodes(image.methods())
          .some((node) => node.path.join(" ") === "kiten cardsIn:"),
      );
      const called = await lineOn(stand, policy, ports, "kiten cardsIn: 9101");
      assertEquals([called.exit, called.stderr], [
        2,
        "mpu kiten: не понимает cardsIn:\n",
      ]);
      const again = await lineOn(
        stand,
        policy,
        ports,
        "ask kiten forget: cardsIn",
        ["y"],
      );
      assertEquals([again.exit, again.stderr], [
        1,
        "mpu kiten forget: у kiten нет метода cardsIn:\n",
      ]);
    })
  ));

Deno.test("image.db — мусор: «образ: …», код 1, до разбора", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      await Deno.writeTextFile(file, "не база ".repeat(200));
      using image = Image.at(file);
      for (const line of ["kiten ls", "nonsense ^"]) {
        const ran = await lineOn(stand, policy, imaging(image), line);
        assertEquals(ran.exit, 1, line);
        assert(ran.stderr.startsWith("образ: "), ran.stderr);
      }
      assertEquals(stand.asked(), 0);
    })
  ));

Deno.test("запрет правила на define: — код 1; нет HOME — отказ записи, код 1", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      {
        using book = RuleBook.open(policy, registrySeeds());
        book.set(RulePath.parse("kiten define:"), DENY);
      }
      using image = Image.at(file);
      const denied = await lineOn(stand, policy, imaging(image), CARDS_IN);
      assertEquals([denied.exit, denied.stderr], [
        1,
        `mpu ${CARDS_IN.slice(4)}: запрещено правилом «kiten define:»\n`,
      ]);
      using homeless = Image.at(undefined);
      const allowed = CARDS_IN.replace("define: cardsIn", "define: other");
      {
        using book = RuleBook.open(policy, registrySeeds());
        book.set(RulePath.parse("kiten define:"), ALLOW);
      }
      const nowhere = await lineOn(stand, policy, imaging(homeless), allowed);
      assertEquals([nowhere.exit, nowhere.stderr], [
        1,
        "образ: каталог состояния не задан (нет HOME)\n",
      ]);
      assertEquals(ruleOf(policy, "kiten other:"), undefined);
    })
  ));

Deno.test("forget: с лишним словом — не строка образа", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ran = await lineOn(
        stand,
        policy,
        imaging(image),
        "ask kiten forget: cardsIn x",
      );
      assertEquals(ran.exit, 2);
      assert(
        ran.stderr.startsWith("mpu ask kiten: не понимает forget:"),
        ran.stderr,
      );
    })
  ));
