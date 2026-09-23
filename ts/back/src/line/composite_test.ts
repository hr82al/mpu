/**
 * `ask` в составной строке (`platform/ask-composite.md`): обход до
 * исполнения собирает достижимые команды и решает их правилами; вопрос —
 * на каждую запись в момент отправки. Строки — на подменённом Kaiten:
 * `kiten ls` — allow (карточки 11, 12, 13), `kiten comment` — ask, `sql` —
 * deny.
 */

import { assertEquals } from "@std/assert";
import { ASK, DENY, RuleBook, RulePath } from "../policy/mod.ts";
import {
  COMPOSITE_DIR,
  compositeFiles,
  runComposite,
} from "./testcomposite.ts";
import { allowEverything, withPolicyFile } from "./testconsent.ts";
import { runOnStand, type Stand, unmarked, withStand } from "./testprogram.ts";

/** Строка с метками — словами строки. */
function words(line: string): string[] {
  return unmarked(line).split(" ");
}

/** Правила сценариев: чтение — allow, комментарий — ask, `sql` — deny. */
function rules(file: string) {
  allowEverything(file);
  using book = RuleBook.open(file, []);
  book.set(RulePath.parse("kiten comment"), ASK);
  book.set(RulePath.parse("sql"), DENY);
}

/** Строка вопроса о комментарии к карточке `id`. */
function question(id: number): string {
  return `выполнить mpu kiten comment id: ${id} text: ping? [y/N] `;
}

const LOOP =
  "kiten ls each: {do} {:}c kiten comment id: {@}c id text: ping {done}";

/** Строка на стенде с правилами сценариев. */
function onStand(
  body: (file: string, stand: Stand) => Promise<void>,
): Promise<void> {
  return withPolicyFile((file) =>
    withStand((stand) => {
      rules(file);
      return body(file, stand);
    })
  );
}

Deno.test("запись без ask — отказ всей строки до исполнения", () =>
  onStand(async (file, stand) => {
    const line = words(LOOP);
    const ran = await runOnStand(file, line, stand);
    const text = unmarked(LOOP);
    assertEquals(
      ran.stderr,
      `mpu ${text}: строка может записать (kiten comment) — начни с ` +
        `ask: mpu ask ${text}\n`,
    );
    assertEquals([ran.exit, stand.asked(), stand.posted()], [2, 0, []]);
    // Отказ обхода — до записи журнала: программа не отмечена.
    assertEquals([ran.native, ran.records], [[], []]);
    assertEquals(ran.refusals.map((one) => [one.reason, one.hint]), [
      ["строка может записать", ["ask", ...line]],
    ]);
  }));

Deno.test("с ask — вопрос на каждую запись, да да да", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(file, words(`ask ${LOOP}`), stand, {
      answers: ["y", "y", "y"],
    });
    assertEquals(ran.exit, 0, ran.stderr);
    assertEquals(ran.stderr, question(11) + question(12) + question(13));
    assertEquals(stand.posted(), ["11 ping", "12 ping", "13 ping"]);
    assertEquals(
      ran.records.map((record) => [record.argv.join(" "), record.native]),
      [
        ["ask kiten ls", ["kiten ls"]],
        ["ask kiten comment id: 11 text: ping", ["kiten comment"]],
        ["ask kiten comment id: 12 text: ping", ["kiten comment"]],
        ["ask kiten comment id: 13 text: ping", ["kiten comment"]],
      ],
    );
  }));

Deno.test("нет — вычисление останавливается, дальше вопросов нет", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(file, words(`ask ${LOOP}`), stand, {
      answers: ["y", "n", "y"],
    });
    assertEquals(ran.exit, 1);
    assertEquals(
      ran.stderr,
      question(11) + question(12) +
        "mpu kiten comment id: 12 text: ping: не подтверждено\n",
    );
    assertEquals(stand.posted(), ["11 ping"]);
    assertEquals(
      ran.records.map((record) => [record.argv.join(" "), record.native]),
      [
        ["ask kiten ls", ["kiten ls"]],
        ["ask kiten comment id: 11 text: ping", ["kiten comment"]],
        ["ask kiten comment id: 12 text: ping", []],
      ],
    );
  }));

Deno.test("пять записей, да да нет — четвёртая и пятая не спрошены", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(
      file,
      words(
        "ask 1 to: 5 do: {do} {:}i kiten comment id: 11 text: {do} {@}i {end} {done}",
      ),
      stand,
      { answers: ["y", "y", "n", "y", "y"] },
    );
    assertEquals(ran.exit, 1);
    assertEquals(stand.posted(), ["11 1", "11 2"]);
    assertEquals(ran.stderr.split("[y/N]").length - 1, 3);
  }));

Deno.test("лишний ask на строке без записей — без вопросов", async (t) => {
  for (
    const line of ["ask kiten ls {end} size", "ask kiten ls {.} 2 plus: 2"]
  ) {
    await t.step(line, () =>
      onStand(async (file, stand) => {
        const ran = await runOnStand(file, words(line), stand);
        assertEquals([ran.exit, ran.stderr], [0, ""]);
      }));
  }
});

Deno.test("deny в теле блока — отказ правила до исполнения", async (t) => {
  const line = "kiten ls each: {do} {:}c sql target: 1 sql: x {done}";
  for (const said of [line, `ask ${line}`]) {
    await t.step(said, () =>
      onStand(async (file, stand) => {
        const ran = await runOnStand(file, words(said), stand);
        assertEquals(
          [ran.exit, ran.stderr, stand.asked()],
          [1, "mpu sql: запрещено правилом «sql»\n", 0],
        );
        assertEquals([ran.native, ran.records], [[], []]);
      }));
  }
});

Deno.test("запрет старше записи без двери, где бы ни стоял", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(
      file,
      words("kiten comment id: 11 text: a {.} sql target: 1 sql: x"),
      stand,
    );
    assertEquals(
      [ran.exit, ran.stderr, stand.posted()],
      [1, "mpu sql: запрещено правилом «sql»\n", []],
    );
  }));

Deno.test("правило сменил другой процесс — отказ всей строки при отправке", () =>
  withPolicyFile((file) =>
    withStand(
      async (stand) => {
        allowEverything(file);
        const ran = await runOnStand(file, words(LOOP), stand);
        const text = unmarked(LOOP);
        assertEquals(
          ran.stderr,
          `mpu ${text}: строка может записать (kiten comment) — начни с ` +
            `ask: mpu ask ${text}\n`,
        );
        assertEquals([ran.exit, stand.asked(), stand.posted()], [2, 1, []]);
      },
      () => {
        using book = RuleBook.open(file, []);
        book.set(RulePath.parse("kiten comment"), ASK);
      },
    )
  ));

Deno.test("агент без человека — первый вопрос: спросить некого", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(file, words(`ask ${LOOP}`), stand, {
      io: { stdinIsTerminal: () => false },
    });
    assertEquals(ran.exit, 1);
    assertEquals(stand.posted(), []);
    assertEquals(
      ran.stderr,
      "mpu kiten comment id: 11 text: ping: нужно подтверждение, а спросить некого\n",
    );
  }));

Deno.test("голдены composite-*: прогон на стенде совпадает", async (t) => {
  for (const name of await compositeFiles()) {
    await t.step(name, async () => {
      const kept = JSON.parse(
        await Deno.readTextFile(new URL(name, COMPOSITE_DIR)),
      );
      assertEquals(await runComposite(kept), kept);
    });
  }
});
