/**
 * Подсказка ближайшим (`platform/refusal-object.md`): одна ближайшая —
 * строка с ней вместо непонятого слова; иначе подсказать нечего.
 */

import { assertEquals } from "@std/assert";
import type { Scene } from "./protocol.ts";
import { nearestOf } from "./remedy.ts";

/** Место отказа: сообщение `[start, end)` строки `line`. */
function scene(line: readonly string[], start: number, end: number): Scene {
  return { address: "mpu", taken: [], line, start, end };
}

Deno.test("ближайшее вместо непонятого: слова и случаи без подсказки", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly selector: string;
    readonly candidates: readonly string[];
    readonly at: Scene;
    readonly words: readonly string[] | null;
  }[] = [
    {
      name: "унарное — прочие слова как набраны",
      selector: "crad",
      candidates: ["card"],
      at: scene(["kiten", "crad", "id:", "1"], 1, 2),
      words: ["kiten", "card", "id:", "1"],
    },
    {
      name: "ключ — значение на месте",
      selector: "idd:",
      candidates: ["id:"],
      at: scene(["kiten", "card", "idd:", "1"], 2, 4),
      words: ["kiten", "card", "id:", "1"],
    },
    {
      name: "ближайших два — нечего",
      selector: "car",
      candidates: ["card", "card:"],
      at: scene(["car"], 0, 1),
      words: null,
    },
    {
      name: "ключ набран флагом — слова селектора нет",
      selector: "idd:",
      candidates: ["id:"],
      at: scene(["kiten", "card", "--idd", "1"], 2, 4),
      words: null,
    },
    {
      name: "частей у ближайшего другое число — нечего",
      selector: "idd:",
      candidates: ["id:text:"],
      at: scene(["kiten", "card", "idd:", "1"], 2, 4),
      words: null,
    },
  ];
  for (const c of cases) {
    await t.step(c.name, () => {
      const hint = nearestOf(c.selector, c.candidates).hint(c.at);
      assertEquals([hint.words(), hint.said()], [c.words, ""]);
    });
  }
});
