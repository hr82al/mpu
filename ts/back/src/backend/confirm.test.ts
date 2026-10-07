/**
 * Что уходит в чат владельца (`platform/ask-telegram.md`, «Что не уходит
 * в чат» [S6]): только подтверждение вида `line` с хвостом `[y/N] `.
 */

import { describe, expect, it } from "vitest";
import type { Form, OwnerQuestions } from "../botquestions/mod.ts";
import { NO_BOT, REAL_CLOCK } from "../botquestions/mod.ts";
import {
  NO_WINDOWS,
  sessionKeyOf,
  Sessions,
  Windows,
} from "../claudehook/mod.ts";
import { type AskKind, SESSION_ENV } from "../frames/mod.ts";
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

describe("S6: в чат — только подтверждение вида line", () => {
  const cases: readonly (readonly [string, AskKind, number])[] = [
    ["выполнить mpu x? [y/N] ", "line", 1],
    ["Пароль GitLab [y/N] ", "secret", 0],
    ["Пароль GitLab: ", "secret", 0],
    ["Set up Telegram now? [y/N]: ", "line", 0],
    ["api_id (integer): ", "line", 0],
  ];
  for (const [text, kind, asked] of cases) {
    it(`${kind} ${JSON.stringify(text)}`, async () => {
      const forms: Form[] = [];
      const { questions, asked: posed } = recording(forms);
      const confirms = new ChatConfirms({
        questions,
        windows: NO_WINDOWS,
        env: () => undefined,
        head: "❓ mpu ask",
        sessions: new Sessions(REAL_CLOCK),
      });
      const rivalry = confirms.rival(text, kind).start(() => {});
      if (asked > 0) await posed;
      rivalry.lapsed();
      await rivalry.closed();
      expect(forms.length).toStrictEqual(asked);
    });
  }
});

describe("ответ канала раньше подписи окна — в чат ничего; сбой tmux — без подписи", () => {
  it("ответ раньше подписи", async () => {
    const forms: Form[] = [];
    const caption = Promise.withResolvers<string | undefined>();
    const confirms = new ChatConfirms({
      questions: recording(forms).questions,
      windows: new Windows(() => caption.promise),
      env: (name) =>
        ({ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%1" })[name],
      head: "❓ mpu ask",
      sessions: new Sessions(REAL_CLOCK),
    });
    const rivalry = confirms
      .rival("выполнить mpu x? [y/N] ", "line")
      .start(() => {});
    rivalry.answered();
    caption.resolve("w:2 claude\n");
    await rivalry.closed();
    expect(forms).toStrictEqual([]);
  });
  it("сбой tmux", async () => {
    const forms: Form[] = [];
    const { questions, asked } = recording(forms);
    const confirms = new ChatConfirms({
      questions,
      windows: new Windows(() => Promise.reject(new Error("tmux упал"))),
      env: (name) =>
        ({ TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%1" })[name],
      head: "❓ mpu ask",
      sessions: new Sessions(REAL_CLOCK),
    });
    const rivalry = confirms
      .rival("выполнить mpu x? [y/N] ", "line")
      .start(() => {});
    await asked;
    rivalry.lapsed();
    await rivalry.closed();
    expect(forms[0].title.line("❓ mpu ask", 1, 1)).toBe("❓ mpu ask");
  });
});

it("R3c-6: подтверждение в ряду — срочный вопрос сессии: снимка окна нет", async () => {
  const forms: Form[] = [];
  const { questions, asked } = recording(forms);
  const sessions = new Sessions(REAL_CLOCK);
  const env = (name: string) =>
    ({ [SESSION_ENV]: "/run/user/1000/cc-socks/k.sock" })[name];
  const confirms = new ChatConfirms({
    questions,
    windows: NO_WINDOWS,
    env,
    head: "❓ mpu ask",
    sessions,
  });
  const snapshot = () =>
    sessionKeyOf(env).seatSnapshot(sessions, () => NO_BOT.ask(forms[0]), {
      seated: () => "снимок",
      busy: () => "вопрос уже в чате",
    });
  const rivalry = confirms
    .rival("выполнить mpu x? [y/N] ", "line")
    .start(() => {});
  await asked;
  expect(snapshot()).toBe("вопрос уже в чате");
  rivalry.lapsed();
  await rivalry.closed();
  // Вопрос решён — сессия отпущена.
  expect(snapshot()).toBe("снимок");
});
