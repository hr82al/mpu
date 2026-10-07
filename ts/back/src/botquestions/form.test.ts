/**
 * Заголовок вопроса (`docs/specs/platform/telegram-questions.md`, «Форма
 * вопроса и исход», «Уточнения R1a»): голова, ` — `, места через ` · `;
 * номер шага — после головы.
 */

import { describe, expect, it } from "vitest";
import { Title } from "./form.ts";

describe("заголовок: голова — места через «·»; мест нет — нет и «—»", () => {
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
    it(line, () => expect(title.line(head, step, steps)).toStrictEqual(line));
  }
});
