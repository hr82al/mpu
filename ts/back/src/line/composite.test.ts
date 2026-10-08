/**
 * `ask` на строке без записей (`platform/ask-composite.md`): лишняя дверь
 * вопросов не задаёт. Строки — на подменённом Kaiten: `kiten ls` — allow
 * (карточки 11, 12, 13), `kiten comment` — ask, `sql` — deny.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ASK, DENY, RuleBook, RulePath } from "@mpu/command/policy";
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

describe("лишний ask на строке без записей — без вопросов", () => {
  for (const line of ["ask kiten ls {end} size"]) {
    it(line, () =>
      onStand(async (file, stand) => {
        const ran = await runOnStand(file, words(line), stand);
        expect([ran.exit, ran.stderr]).toStrictEqual([0, ""]);
      }),
    );
  }
});

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
