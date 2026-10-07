/**
 * Методы образа через ядро строки (`platform/image.md`, «Граничные
 * случаи»): определение, вызов, отражение, удаление, чужой процесс,
 * мусор вместо файла. Kaiten подменён (`testprogram.ts`), правила и образ
 * — во временном каталоге.
 */

import { readFile, writeFile } from "node:fs/promises";
import { assert, expect, it } from "vitest";
import { Image } from "../image/mod.ts";
import { makeInvokeLog } from "../invokelog/mod.ts";
import { runLog } from "../log/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
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

it("define: с «да» — метод записан, правило посева allow, вызов — число", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const changes: string[] = [];
      const ports = imaging(image, changes);
      const defined = await lineOn(stand, policy, ports, CARDS_IN, ["y"]);
      expect(defined.exit).toBe(0);
      expect(defined.stdout).toBe(
        '{"path":"kiten cardsIn:","verdict":"allow"}\n',
      );
      expect(defined.stderr).toStrictEqual(
        `выполнить mpu ${CARDS_IN.slice(4)}? [y/N] `,
      );
      expect(changes).toStrictEqual(["changed"]);
      expect(ruleOf(policy, "kiten cardsIn:")).toBe("allow");
      const called = await lineOn(
        stand,
        policy,
        ports,
        "kiten cardsIn: 9101 end size",
      );
      expect([called.exit, called.stdout, called.stderr]).toStrictEqual([
        0,
        "2\n",
        "",
      ]);
      // Журнал: вызов метода своей записью, затем команда тела.
      expect(called.records.map((record) => record.argv.join(" ")))
        .toStrictEqual([
          "kiten cardsIn: 9101",
          "kiten ls",
        ]);
    })
  ));

it("метод отвечает протоколу: messages, understands:, help, complete:, снимок", () =>
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
      expect(understands.stdout).toBe("true\n");
      const help = await lineOn(stand, policy, ports, "kiten cardsIn: help");
      expect(help.exit).toBe(0);
      expect(help.stdout.split("\n\n")).toStrictEqual([
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
      expect(complete.stdout.split("\n").map((row) => row.split("\t")[0]))
        .toStrictEqual([
          "card",
          "cardsIn:",
          "",
        ]);
      const node = registryNodes(image.methods())
        .find((one) => one.path.join(" ") === "kiten cardsIn:");
      expect(node?.image).toStrictEqual({
        author: "human",
        time: "2026-09-23T10:00:00.000Z",
        source: "do :col kiten ls where: column is: @col done",
        definition:
          "kiten define: cardsIn: purpose: ^мои в колонке^ keys: ^id колонки^ do :col kiten ls where: column is: @col done",
      });
    })
  ));

it("голдены testdata/image: прогон на стенде совпадает", async () => {
  const taken = await imageGoldens();
  for (const [name, text] of Object.entries(taken)) {
    const kept = await readFile(new URL(name, IMAGE_DIR), "utf8");
    expect(text, name).toStrictEqual(kept);
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

it("отказы определения — код 2, ничего не записано", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ports = imaging(image);
      for (const [line, stderr] of MISDEFINED) {
        const ran = await lineOn(stand, policy, ports, line, ["y"]);
        expect([ran.exit, ran.stderr, ran.stdout], line).toStrictEqual([
          2,
          stderr,
          "",
        ]);
      }
      expect(image.methods()).toStrictEqual([]);
    })
  ));

it("метод, достигающий записи: посев ask; без ask — отказ; вопрос на каждый вызов", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ports = imaging(image);
      const defined = await lineOn(stand, policy, ports, PING_ALL, ["y"]);
      expect(defined.stdout).toBe('{"path":"kiten pingAll","verdict":"ask"}\n');
      expect(ruleOf(policy, "kiten pingAll")).toBe("ask");
      const bare = await lineOn(stand, policy, ports, "kiten pingAll");
      expect([bare.exit, bare.stderr]).toStrictEqual([
        2,
        "mpu kiten pingAll: строка может записать (kiten pingAll) — начни с " +
        "ask: mpu ask kiten pingAll\n",
      ]);
      expect(stand.asked()).toBe(0);
      const no = await lineOn(stand, policy, ports, "ask kiten pingAll", ["n"]);
      expect([no.exit, no.stderr]).toStrictEqual([
        1,
        "выполнить mpu kiten pingAll? [y/N] mpu kiten pingAll: не подтверждено\n",
      ]);
      expect(stand.asked()).toBe(0);
      const twice = await lineOn(
        stand,
        policy,
        ports,
        "ask 1 to: 2 do: do :i kiten pingAll done",
        ["y", "y", "y", "y", "n"],
      );
      expect(twice.exit).toBe(1);
      expect(twice.stderr.split("? [y/N] ").slice(0, 5)).toStrictEqual([
        "выполнить mpu kiten pingAll",
        "выполнить mpu kiten comment id: 11 text: ping",
        "выполнить mpu kiten comment id: 12 text: ping",
        "выполнить mpu kiten comment id: 13 text: ping",
        "выполнить mpu kiten pingAll",
      ]);
      expect(stand.posted()).toStrictEqual(["11 ping", "12 ping", "13 ping"]);
    })
  ));

it("метод, определённый другим процессом, виден следующей строке", () =>
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
      expect(first.stdout).toBe("2\n");
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
      expect([second.exit, second.stdout]).toStrictEqual([0, "3\n"]);
    })
  ));

it("forget: — метод исчез из отражения, дополнения, снимка и правил", () =>
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
      expect(forgot.stdout).toBe('{"path":"kiten cardsIn:","verdict":null}\n');
      expect(changes).toStrictEqual(["changed", "changed"]);
      expect(ruleOf(policy, "kiten cardsIn:")).toStrictEqual(undefined);
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
      expect([called.exit, called.stderr]).toStrictEqual([
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
      expect([again.exit, again.stderr]).toStrictEqual([
        1,
        "mpu kiten forget: у kiten нет метода cardsIn:\n",
      ]);
    })
  ));

it("image.db — мусор: «образ: …», код 1, до разбора", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      await writeFile(file, "не база ".repeat(200));
      using image = Image.at(file);
      for (const line of ["kiten ls", "nonsense ^"]) {
        const ran = await lineOn(stand, policy, imaging(image), line);
        expect(ran.exit, line).toBe(1);
        assert(ran.stderr.startsWith("образ: "), ran.stderr);
      }
      expect(stand.asked()).toBe(0);
    })
  ));

it("запрет правила на define: — код 1; нет HOME — отказ записи, код 1", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      {
        using book = RuleBook.open(policy, registrySeeds());
        book.set(RulePath.parse("kiten define:"), DENY);
      }
      using image = Image.at(file);
      const denied = await lineOn(stand, policy, imaging(image), CARDS_IN);
      expect([denied.exit, denied.stderr]).toStrictEqual([
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
      expect([nowhere.exit, nowhere.stderr]).toStrictEqual([
        1,
        "образ: каталог состояния не задан (нет HOME)\n",
      ]);
      expect(ruleOf(policy, "kiten other:")).toStrictEqual(undefined);
    })
  ));

it("forget: с лишним словом — не строка образа", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ran = await lineOn(
        stand,
        policy,
        imaging(image),
        "ask kiten forget: cardsIn x",
      );
      expect(ran.exit).toBe(2);
      assert(
        ran.stderr.startsWith("mpu ask kiten: не понимает forget:"),
        ran.stderr,
      );
    })
  ));

/** Запись журнала без времени, pid и run_id: их тест не сверяет. */
function stable(record: string): string {
  return record
    .replace(/^### .*$/m, "### <шапка>")
    .replaceAll(/run=\S+/g, "run=<id>")
    .replace(/dur=\S+s/, "dur=<сек>s");
}

/** Последняя запись журнала `file`, отобранная `cmd:`, как её печатает `mpu log`. */
async function lastRecord(file: string, cmd?: string): Promise<string> {
  const io = makeFakeIo({ readTextFile: (path) => readFile(path, "utf8") });
  const result = await runLog({
    tail: 1,
    failed: false,
    cmd,
    since: undefined,
    run: undefined,
    file,
  }, io);
  return stable(result.records.join(""));
}

/** Ожидаемая запись J1–J2 (`platform/image.md`, «Журнал вызовов»). */
function journaled(line: string, out: string): string {
  return `### <шапка>\n$ mpu ${line}\n--- out run=<id> ---\n${out}` +
    "--- end run=<id> exit=0 dur=<сек>s ---\n\n";
}

/** Ожидаемая запись отказа J3–J3b: секция `err` и код. */
function refusedRecord(line: string, err: string, exit: number): string {
  return `### <шапка>\n$ mpu ${line}\n--- err run=<id> ---\n${err}` +
    `--- end run=<id> exit=${exit} dur=<сек>s ---\n\n`;
}

/** Журнал вызовов во временном каталоге рядом с образом. */
function journalBeside(image: string) {
  const file = image.replace(/image\.db$/, "mpu.log");
  const log = makeInvokeLog({
    env: { get: () => undefined },
    defaultFile: file,
    pid: 1,
    now: () => new Date(),
  });
  return { file, log };
}

it("журнал: define: и forget: — по записи со строкой, out и кодом (J1, J2, J4)", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ports = imaging(image);
      const { file: journal, log } = journalBeside(file);
      const run = (line: string) =>
        runOnStand(policy, words(line), stand, {
          image: ports,
          answers: ["y"],
          log,
        });
      const defined = await run(
        "ask kiten define: probe purpose: ^проба^ do kiten whoami done",
      );
      expect(defined.exit).toBe(0);
      const j1 = journaled(
        "ask kiten define: probe purpose: '^проба^' do kiten whoami done",
        '{"path":"kiten probe","verdict":"allow"}\n',
      );
      expect(await lastRecord(journal), "J1").toStrictEqual(j1);
      expect(await lastRecord(journal, "kiten"), "J4").toStrictEqual(j1);
      const forgot = await run("ask kiten forget: probe");
      expect(forgot.exit).toBe(0);
      expect(await lastRecord(journal), "J2").toStrictEqual(
        journaled("ask kiten forget: probe", forgot.stdout),
      );
    })
  ));

it("журнал: отказ самой строки define:/forget: — запись с err и кодом (J3, J3b)", () =>
  withState(({ policy, image: file }) =>
    withStand(async (stand) => {
      using image = Image.at(file);
      const ports = imaging(image);
      const { file: journal, log } = journalBeside(file);
      const cases = [
        {
          name: "J3",
          line: "ask kiten define: cardsIn do :c kiten ls done",
          said: "mpu kiten define: метод без назначения: purpose: ^…^",
          exit: 2,
        },
        {
          name: "J3b",
          line: "ask kiten forget: cardsIn",
          said: "mpu kiten forget: у kiten нет метода cardsIn:",
          exit: 1,
        },
      ];
      for (const { name, line, said, exit } of cases) {
        const ran = await runOnStand(policy, words(line), stand, {
          image: ports,
          answers: ["y"],
          log,
        });
        expect(ran.exit, name).toStrictEqual(exit);
        assert(ran.stderr.startsWith(said), `${name}: ${ran.stderr}`);
        expect(await lastRecord(journal), name).toStrictEqual(
          refusedRecord(line, ran.stderr, exit),
        );
      }
    })
  ));
