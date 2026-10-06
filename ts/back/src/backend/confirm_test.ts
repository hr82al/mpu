/**
 * Что уходит в чат владельца (`platform/ask-telegram.md`, «Что не уходит
 * в чат» [S6]): только подтверждение вида `line` с хвостом `[y/N] `.
 */

import { assertEquals } from "@std/assert";
import type { Form, OwnerQuestions } from "../botquestions/mod.ts";
import { NO_BOT } from "../botquestions/mod.ts";
import { NO_WINDOWS, Windows } from "../claudehook/mod.ts";
import type { AskKind } from "../frames/mod.ts";
import { ChatConfirms } from "./confirm.ts";

/**
 * Вопросы, которые записывают формы и отвечают отказом, как без бота;
 * `asked` — первый вопрос задан.
 */
function recording(forms: Form[]) {
  const asked = Promise.withResolvers<void>();
  const questions: Pick<OwnerQuestions, "ask"> = {
    ask(form) {
      forms.push(form);
      asked.resolve();
      return NO_BOT.ask(form);
    },
  };
  return { questions, asked: asked.promise };
}

Deno.test("S6: в чат — только подтверждение вида line", async (t) => {
  const cases: readonly (readonly [string, AskKind, number])[] = [
    ["выполнить mpu x? [y/N] ", "line", 1],
    ["Пароль GitLab [y/N] ", "secret", 0],
    ["Пароль GitLab: ", "secret", 0],
    ["Set up Telegram now? [y/N]: ", "line", 0],
    ["api_id (integer): ", "line", 0],
  ];
  for (const [text, kind, asked] of cases) {
    await t.step(`${kind} ${JSON.stringify(text)}`, async () => {
      const forms: Form[] = [];
      const { questions, asked: posed } = recording(forms);
      const confirms = new ChatConfirms({
        questions,
        windows: NO_WINDOWS,
        env: () => undefined,
        head: "❓ mpu ask",
      });
      const rivalry = confirms.rival(text, kind).start(() => {});
      if (asked > 0) await posed;
      rivalry.lapsed();
      await rivalry.closed();
      assertEquals(forms.length, asked);
    });
  }
});

Deno.test("ответ канала раньше подписи окна — в чат ничего; сбой tmux — без подписи", async (t) => {
  await t.step("ответ раньше подписи", async () => {
    const forms: Form[] = [];
    const caption = Promise.withResolvers<string | undefined>();
    const confirms = new ChatConfirms({
      questions: recording(forms).questions,
      windows: new Windows(() => caption.promise),
      env: (name) =>
        ({ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%1" })[name],
      head: "❓ mpu ask",
    });
    const rivalry = confirms.rival("выполнить mpu x? [y/N] ", "line").start(
      () => {},
    );
    rivalry.answered();
    caption.resolve("w:2 claude\n");
    await rivalry.closed();
    assertEquals(forms, []);
  });
  await t.step("сбой tmux", async () => {
    const forms: Form[] = [];
    const { questions, asked } = recording(forms);
    const confirms = new ChatConfirms({
      questions,
      windows: new Windows(() => Promise.reject(new Error("tmux упал"))),
      env: (name) =>
        ({ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%1" })[name],
      head: "❓ mpu ask",
    });
    const rivalry = confirms.rival("выполнить mpu x? [y/N] ", "line").start(
      () => {},
    );
    await asked;
    rivalry.lapsed();
    await rivalry.closed();
    assertEquals(forms[0].title.line("❓ mpu ask", 1, 1), "❓ mpu ask");
  });
});
