/**
 * `ask` в составной строке (`platform/ask-composite.md`): обход до
 * исполнения собирает достижимые команды и решает их правилами; вопрос —
 * на каждую запись в момент отправки. Строки — на подменённом Kaiten:
 * `kiten ls` — allow (карточки 11, 12, 13), `kiten comment` — ask, `sql` —
 * deny.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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
    }),
  );
}

it("запись без ask — отказ всей строки до исполнения", () =>
  onStand(async (file, stand) => {
    const line = words(LOOP);
    const ran = await runOnStand(file, line, stand);
    const text = unmarked(LOOP);
    expect(ran.stderr).toStrictEqual(
      `mpu ${text}: строка может записать (kiten comment) — начни с ` +
        `ask: mpu ask ${text}\n`,
    );
    expect([ran.exit, stand.asked(), stand.posted()]).toStrictEqual([2, 0, []]);
    // Отказ обхода — до записи журнала: программа не отмечена.
    expect([ran.native, ran.records]).toStrictEqual([[], []]);
    expect(ran.refusals.map((one) => [one.reason, one.hint])).toStrictEqual([
      ["строка может записать", ["ask", ...line]],
    ]);
  }));

it("с ask — вопрос на каждую запись, да да да", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(file, words(`ask ${LOOP}`), stand, {
      answers: ["y", "y", "y"],
    });
    expect(ran.exit, ran.stderr).toBe(0);
    expect(ran.stderr).toStrictEqual(
      question(11) + question(12) + question(13),
    );
    expect(stand.posted()).toStrictEqual(["11 ping", "12 ping", "13 ping"]);
    expect(
      ran.records.map((record) => [record.argv.join(" "), record.native]),
    ).toStrictEqual([
      ["ask kiten ls", ["kiten ls"]],
      ["ask kiten comment id: 11 text: ping", ["kiten comment"]],
      ["ask kiten comment id: 12 text: ping", ["kiten comment"]],
      ["ask kiten comment id: 13 text: ping", ["kiten comment"]],
    ]);
  }));

it("нет — вычисление останавливается, дальше вопросов нет", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(file, words(`ask ${LOOP}`), stand, {
      answers: ["y", "n", "y"],
    });
    expect(ran.exit).toBe(1);
    expect(ran.stderr).toStrictEqual(
      question(11) +
        question(12) +
        "mpu kiten comment id: 12 text: ping: не подтверждено\n",
    );
    expect(stand.posted()).toStrictEqual(["11 ping"]);
    expect(
      ran.records.map((record) => [record.argv.join(" "), record.native]),
    ).toStrictEqual([
      ["ask kiten ls", ["kiten ls"]],
      ["ask kiten comment id: 11 text: ping", ["kiten comment"]],
      ["ask kiten comment id: 12 text: ping", []],
    ]);
  }));

it("пять записей, да да нет — четвёртая и пятая не спрошены", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(
      file,
      words(
        "ask 1 to: 5 do: {do} {:}i kiten comment id: 11 text: {do} {@}i {end} {done}",
      ),
      stand,
      { answers: ["y", "y", "n", "y", "y"] },
    );
    expect(ran.exit).toBe(1);
    expect(stand.posted()).toStrictEqual(["11 1", "11 2"]);
    expect(ran.stderr.split("[y/N]").length - 1).toBe(3);
  }));

describe("лишний ask на строке без записей — без вопросов", () => {
  for (const line of [
    "ask kiten ls {end} size",
    "ask kiten ls {.} 2 plus: 2",
  ]) {
    it(line, () =>
      onStand(async (file, stand) => {
        const ran = await runOnStand(file, words(line), stand);
        expect([ran.exit, ran.stderr]).toStrictEqual([0, ""]);
      }),
    );
  }
});

describe("deny в теле блока — отказ правила до исполнения", () => {
  const line = "kiten ls each: {do} {:}c sql target: 1 sql: x {done}";
  for (const said of [line, `ask ${line}`]) {
    it(said, () =>
      onStand(async (file, stand) => {
        const ran = await runOnStand(file, words(said), stand);
        expect([ran.exit, ran.stderr, stand.asked()]).toStrictEqual([
          1,
          "mpu sql: запрещено правилом «sql»\n",
          0,
        ]);
        expect([ran.native, ran.records]).toStrictEqual([[], []]);
      }),
    );
  }
});

it("запрет старше записи без двери, где бы ни стоял", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(
      file,
      words("kiten comment id: 11 text: a {.} sql target: 1 sql: x"),
      stand,
    );
    expect([ran.exit, ran.stderr, stand.posted()]).toStrictEqual([
      1,
      "mpu sql: запрещено правилом «sql»\n",
      [],
    ]);
  }));

it("правило сменил другой процесс — отказ всей строки при отправке", () =>
  withPolicyFile((file) =>
    withStand(
      async (stand) => {
        allowEverything(file);
        const ran = await runOnStand(file, words(LOOP), stand);
        const text = unmarked(LOOP);
        expect(ran.stderr).toStrictEqual(
          `mpu ${text}: строка может записать (kiten comment) — начни с ` +
            `ask: mpu ask ${text}\n`,
        );
        expect([ran.exit, stand.asked(), stand.posted()]).toStrictEqual([
          2,
          1,
          [],
        ]);
      },
      () => {
        using book = RuleBook.open(file, []);
        book.set(RulePath.parse("kiten comment"), ASK);
      },
    ),
  ));

it("агент без человека — первый вопрос: спросить некого", () =>
  onStand(async (file, stand) => {
    const ran = await runOnStand(file, words(`ask ${LOOP}`), stand, {
      io: { stdinIsTerminal: () => false },
    });
    expect(ran.exit).toBe(1);
    expect(stand.posted()).toStrictEqual([]);
    expect(ran.stderr).toBe(
      "mpu kiten comment id: 11 text: ping: нужно подтверждение, а спросить некого\n",
    );
  }));

// Сбор асинхронный: перечень голденов — содержимое каталога (Vitest
// дожидается фабрики `describe`). Ресурсов здесь нет — только имена.
describe("голдены composite-*: прогон на стенде совпадает", async () => {
  for (const name of await compositeFiles()) {
    it(name, async () => {
      const kept = JSON.parse(
        await readFile(new URL(name, COMPOSITE_DIR), "utf8"),
      );
      expect(await runComposite(kept)).toStrictEqual(kept);
    });
  }
});
