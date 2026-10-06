/**
 * Заголовок вопроса (`docs/specs/platform/telegram-questions.md`, «Форма
 * вопроса и исход», «Уточнения R1a»): голова, ` — `, места через ` · `;
 * номер шага — после головы.
 */

import { assertEquals } from "@std/assert";
import { Title } from "./form.ts";

Deno.test("заголовок: голова — места через «·»; мест нет — нет и «—»", async (t) => {
  for (
    const [head, title, step, steps, line] of [
      [
        "🔐 Bash",
        new Title(["mpu-bot", "ozon", "w:2 claude"]),
        1,
        1,
        "🔐 Bash — mpu-bot · ozon · w:2 claude",
      ],
      ["🔐 Bash", new Title(["sl-back"]), 1, 1, "🔐 Bash — sl-back"],
      ["🔐 Bash", new Title([]), 1, 1, "🔐 Bash"],
      [
        "❓ Цвет",
        new Title(["mpu-bot", "ozon"]),
        2,
        3,
        "❓ Цвет 2/3 — mpu-bot · ozon",
      ],
      ["❓ Цвет", new Title([]), 2, 3, "❓ Цвет 2/3"],
    ] as const
  ) {
    await t.step(line, () => assertEquals(title.line(head, step, steps), line));
  }
});
