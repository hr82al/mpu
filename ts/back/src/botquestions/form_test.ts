/**
 * Заголовок вопроса (`docs/specs/platform/telegram-questions.md`, «Форма
 * вопроса и исход», «Уточнения R1a»): голова, ` — `, места через ` · `;
 * номер шага — после головы.
 */

import { assertEquals } from "@std/assert";
import { Title } from "./form.ts";

Deno.test("заголовок: голова — места через «·»; мест нет — нет и «—»", async (t) => {
  for (
    const [title, step, steps, line] of [
      [
        new Title("🔐 Bash", ["mpu-bot", "ozon", "w:2 claude"]),
        1,
        1,
        "🔐 Bash — mpu-bot · ozon · w:2 claude",
      ],
      [new Title("🔐 Bash", ["sl-back"]), 1, 1, "🔐 Bash — sl-back"],
      [new Title("🔐 Bash", []), 1, 1, "🔐 Bash"],
      [
        new Title("❓ Цвет", ["mpu-bot", "ozon"]),
        2,
        3,
        "❓ Цвет 2/3 — mpu-bot · ozon",
      ],
      [new Title("❓ Цвет", []), 2, 3, "❓ Цвет 2/3"],
    ] as const
  ) {
    await t.step(line, () => assertEquals(title.line(step, steps), line));
  }
});
