import { assertEquals } from "@std/assert";
import { stripAssistantFooter } from "./body.ts";

Deno.test("stripAssistantFooter", async (t) => {
  const cases: Array<[name: string, input: string, expected: string]> = [
    [
      "подпись с markdown-ссылкой",
      "текст описания\n\n" +
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "текст описания",
    ],
    [
      "подпись со ссылкой на сессию отдельной строкой",
      "текст описания\n\n" +
      "🤖 Generated with Claude Code\n" +
      "https://claude.ai/code/session_01QC4yaTL2gKN6YR2HkMtNEc",
      "текст описания",
    ],
    [
      "без пустой строки перед подписью",
      "текст описания\n🤖 Generated with Claude Code",
      "текст описания",
    ],
    [
      "без подписи — текст не трогаем",
      "обычное описание MR без подписи",
      "обычное описание MR без подписи",
    ],
    [
      "упоминание Claude Code внутри текста, не в конце — не подпись",
      "мы обсуждали Generated with Claude Code в прошлом MR",
      "мы обсуждали Generated with Claude Code в прошлом MR",
    ],
  ];
  for (const [name, input, expected] of cases) {
    await t.step(name, () => {
      assertEquals(stripAssistantFooter(input), expected);
    });
  }
});
