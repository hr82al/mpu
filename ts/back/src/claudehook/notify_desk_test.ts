/**
 * Хук `Notification` в ядре (`claude-hook-notification-snapshot.md`;
 * строка-уведомление — `claude-hook-notification.md`; сценарии постановки
 * R4 — номерами в именах тестов). tmux — фейк по снятым экранам, бот —
 * фейк, часы — теста.
 */

import { assertEquals } from "@std/assert";
import {
  f1,
  FakeBot,
  fakeQuestions,
  pressUpdate,
  textUpdate,
} from "../botquestions/testbot.ts";
import { NO_BOT } from "../botquestions/mod.ts";
import { NotifyDesk, SETTLE_QUESTION_MS } from "./notify_desk.ts";
import { Sessions } from "./sessions.ts";
import { LOOK_MS, SETTLE_MS } from "./snapshot.ts";
import { TestClock } from "./testclock.ts";
import { DISK_FILES, Transcripts } from "./transcript.ts";
import { NO_WINDOWS, Windows } from "./window.ts";

const testdata = (name: string) => new URL(`testdata/${name}`, import.meta.url);

const screen = (name: string) =>
  Deno.readTextFile(testdata(`snapshot/${name}`));

const SOCKET = "/run/user/1000/cc-socks/9.sock";
const ENV = {
  TMUX: "/tmp/tmux-1000/default,4242,0",
  TMUX_PANE: "%9",
  CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
};

/** tmux теста: экран — то, что положил тест; вызовы — по порядку. */
class FakeTmux {
  screen = "";
  alive = true;
  readonly sent: string[][] = [];
  /** Сколько раз снимали экран. */
  captures = 0;

  run = (args: readonly string[]): Promise<string | undefined> => {
    if (!this.alive) return Promise.resolve(undefined);
    const command = args[2];
    if (command === "display-message") return Promise.resolve("w:9 probe\n");
    if (command === "capture-pane") {
      this.captures += 1;
      return Promise.resolve(this.screen);
    }
    this.sent.push([...args]);
    return Promise.resolve("");
  };
}

/** Что напечатал ответ хука. */
interface Told {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Стенд стола уведомлений. */
async function withNotify(
  body: (stand: {
    readonly bot: FakeBot;
    readonly clock: TestClock;
    readonly tmux: FakeTmux;
    readonly sessions: Sessions;
    readonly questions: ReturnType<typeof fakeQuestions>;
    readonly notify: (
      type: string,
      env?: Readonly<Record<string, string>>,
    ) => Promise<Told>;
    readonly desk: NotifyDesk;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const transcript = `${dir}/session.jsonl`;
  await Deno.writeTextFile(
    transcript,
    '{"type":"custom-title","customTitle":"probe"}\n',
  );
  const live = JSON.parse(
    await Deno.readTextFile(
      testdata("claude-hook-notification/live-payload-idle-prompt.json"),
    ),
  );
  const bot = new FakeBot();
  const questions = fakeQuestions(bot);
  const clock = new TestClock();
  const tmux = new FakeTmux();
  const sessions = new Sessions(clock);
  const desk = new NotifyDesk({
    questions,
    transcripts: new Transcripts({ files: DISK_FILES, clock }),
    windows: new Windows(tmux.run),
    sessions,
    clock,
    diagnose: () => {},
  });
  questions.start();
  try {
    await body({
      bot,
      clock,
      tmux,
      sessions,
      questions,
      desk,
      notify: async (type, env = ENV) => {
        let stdout = "";
        let stderr = "";
        const reply = await desk.reply(
          JSON.stringify({
            ...live,
            notification_type: type,
            transcript_path: transcript,
          }),
          (name) => env[name as keyof typeof env],
        );
        reply.tell({
          stdout: (text) => void (stdout += text),
          stderr: (text) => void (stderr += text),
        });
        return { stdout, stderr, code: reply.code() };
      },
    });
  } finally {
    await desk.stop();
    await questions.stop();
    await Deno.remove(dir, { recursive: true });
  }
}

const SILENT: Told = { stdout: "", stderr: "", code: 0 };
const HEAD = "🖥 probe — ozon · w:9 probe";

/** Снимок поставлен: 3 с прошли, экран снят. */
async function placed(clock: TestClock, bot: FakeBot, calls = 1) {
  await clock.paused(SETTLE_QUESTION_MS);
  clock.fire(SETTLE_QUESTION_MS);
  await bot.called(calls);
}

Deno.test("R4-1: ожидание права с окном — через 3 с снимок: тело, жирная первая строка, кнопки", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    assertEquals(await notify("permission_prompt"), SILENT);
    assertEquals(bot.calls, []);
    await placed(clock, bot);
    const body = [
      "Bash command",
      "Create empty probe file",
      "touch /home/user/mr/mp/ozon/s1.txt",
      "This command requires approval",
      "Do you want to proceed?",
      "1. Yes",
      "2. Yes, and don’t ask again for: touch *",
      "3. Yes, and switch to auto mode · auto mode handles these prompts for you",
      "4. No",
    ].join("\n");
    assertEquals(bot.calls[0].text, `${HEAD}\n${body}`);
    assertEquals(bot.calls[0].entities, [
      { type: "bold", offset: HEAD.length + 1, length: "Bash command".length },
    ]);
    assertEquals(bot.calls[0].buttons, [
      ["1. Yes"],
      ["2. Yes, and don’t ask again for: touch *"],
      ["3. Yes, and switch to auto mode"],
      ["4. No"],
      ["⏎", "⎋", "↑", "↓"],
      ["весь экран"],
    ]);
  });
});

Deno.test("R4-2, R4-3: AskUserQuestion — пункты с описанием; форма MCP — кнопки только клавиши", async (t) => {
  await t.step(
    "AskUserQuestion",
    () =>
      withNotify(async ({ bot, clock, tmux, notify }) => {
        tmux.screen = await screen("screen-ask-user-question.txt");
        await notify("elicitation_dialog");
        await placed(clock, bot);
        assertEquals(
          bot.calls[0].text.split("\n").slice(1),
          [
            "☐ Цвет",
            "Какой цвет?",
            "1. Красный — Красный цвет",
            "2. Синий — Синий цвет",
            "3. Type something.",
            "4. Chat about this",
          ],
        );
        assertEquals(bot.calls[0].buttons.slice(0, 4), [
          ["1. Красный"],
          ["2. Синий"],
          ["3. Type something."],
          ["4. Chat about this"],
        ]);
      }),
  );
  await t.step(
    "форма MCP",
    () =>
      withNotify(async ({ bot, clock, tmux, notify }) => {
        tmux.screen = await screen("screen-elicitation-fields.txt");
        await notify("elicitation_dialog");
        await placed(clock, bot);
        assertEquals(bot.calls[0].buttons, [["⏎", "⎋", "↑", "↓"], [
          "весь экран",
        ]]);
      }),
  );
});

Deno.test("R4-4: нажатие «2» — send-keys 2, через 1 с диалога нет — «✅ окно сменилось», кнопок нет", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:1")]);
    await clock.paused(SETTLE_MS);
    assertEquals(tmux.sent, [[
      "-S",
      "/tmp/tmux-1000/default",
      "send-keys",
      "-t",
      "%9",
      "2",
    ]]);
    tmux.screen = "● Файл создан.\n";
    clock.fire(SETTLE_MS);
    await bot.called(3);
    assertEquals(
      bot.calls[2].text.split("\n").at(-1),
      "✅ окно сменилось — лента",
    );
    assertEquals(bot.calls[2].buttons, []);
  });
});

Deno.test("R4-5: блок сменился без нажатия — «✅ решено в терминале»; тот же — не снят", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    await clock.paused(LOOK_MS);
    clock.fire(LOOK_MS);
    // Тот же экран: наблюдение встаёт на следующий взгляд, правки нет.
    const first = await Promise.race([
      bot.called(2).then(() => "снят"),
      clock.paused(LOOK_MS).then(() => "ждёт"),
    ]);
    assertEquals(first, "ждёт");
    tmux.screen = await screen("screen-ask-user-question.txt");
    clock.fire(LOOK_MS);
    await bot.called(2);
    assertEquals(bot.calls[1].text.split("\n").at(-1), "✅ решено в терминале");
  });
});

Deno.test("R4-6: tmux не отвечает — «⌛ окно недоступно»", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    await clock.paused(LOOK_MS);
    tmux.alive = false;
    clock.fire(LOOK_MS);
    await bot.called(2);
    assertEquals(bot.calls[1].text.split("\n").at(-1), "⌛ окно недоступно");
  });
});

Deno.test("R4-7, R4-8: у сессии есть вопрос в ряду — снимка нет", async (t) => {
  for (
    const [name, type, seat] of [
      [
        "право (R1)",
        "permission_prompt",
        (
          sessions: Sessions,
          ask: () => ReturnType<ReturnType<typeof fakeQuestions>["ask"]>,
        ) => sessions.of(SOCKET).urgent(ask),
      ],
      [
        "«ждёт ввода» (R2)",
        "idle_prompt",
        (
          sessions: Sessions,
          ask: () => ReturnType<ReturnType<typeof fakeQuestions>["ask"]>,
        ) => sessions.of(SOCKET).replace(ask),
      ],
    ] as const
  ) {
    await t.step(
      name,
      () =>
        withNotify(
          async ({ bot, clock, tmux, notify, sessions, questions, desk }) => {
            tmux.screen = await screen("screen-permission-bash.txt");
            assertEquals(await notify(type), SILENT);
            seat(sessions, () => questions.ask(f1()));
            await bot.called(1);
            await clock.paused(SETTLE_QUESTION_MS);
            clock.fire(SETTLE_QUESTION_MS);
            // Стол довёл решение до конца: снимка нет — окно не снималось.
            await desk.stop();
            assertEquals(tmux.captures, 0);
          },
        ),
    );
  }
});

Deno.test("R4-9: trust_prompt без вопроса, окно известно — снимок", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("trust_prompt");
    await placed(clock, bot);
    assertEquals(bot.calls[0].text.startsWith("🖥 probe"), true);
  });
});

Deno.test("R4-10, R4-11: без окна и не ожидание — строка-уведомление сразу, stdout — номер", async (t) => {
  for (
    const [name, type, env] of [
      ["ожидание без TMUX_PANE", "idle_prompt", {
        CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
      }],
      ["auth_success", "auth_success", ENV],
    ] as const
  ) {
    await t.step(name, () =>
      withNotify(async ({ bot, notify }) => {
        assertEquals(await notify(type, env), {
          stdout: '{"id": 1546}\n',
          stderr: "",
          code: 0,
        });
        assertEquals(
          bot.calls[0].text,
          `Claude · ozon · ${type}\nClaude is waiting for your input`,
        );
        assertEquals(bot.calls[0].buttons, []);
      }));
  }
});

Deno.test("R4-12: текст владельца — send-keys -l <текст> и Enter", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-ask-user-question.txt");
    await notify("elicitation_dialog");
    await placed(clock, bot);
    bot.deliver([textUpdate(1, 111, "Зелёный", 1)]);
    await clock.paused(SETTLE_MS);
    assertEquals(tmux.sent, [
      [
        "-S",
        "/tmp/tmux-1000/default",
        "send-keys",
        "-t",
        "%9",
        "-l",
        "Зелёный",
      ],
      ["-S", "/tmp/tmux-1000/default", "send-keys", "-t", "%9", "Enter"],
    ]);
  });
});

Deno.test("R4-13: «весь экран» — отдельное сообщение моноширинным блоком, без кнопок", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-elicitation-fields.txt");
    await notify("elicitation_dialog");
    await placed(clock, bot);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:200")]);
    await bot.called(3);
    const whole = bot.calls[2];
    assertEquals(whole.method, "send");
    assertEquals(whole.buttons, []);
    assertEquals(whole.text, tmux.screen.trimEnd());
    assertEquals(whole.entities, [{
      type: "pre",
      offset: 0,
      length: whole.text.length,
    }]);
  });
});

Deno.test("структурный вопрос сессии после снимка — снимок «↷ вопрос в чате»", async () => {
  await withNotify(
    async ({ bot, clock, tmux, notify, sessions, questions }) => {
      tmux.screen = await screen("screen-permission-bash.txt");
      await notify("permission_prompt");
      await placed(clock, bot);
      const asked = sessions.of(SOCKET).urgent(() => questions.ask(f1()));
      await bot.called(3);
      assertEquals(bot.calls[1].text.split("\n").at(-1), "↷ вопрос в чате");
      asked.expire();
    },
  );
});

Deno.test("stdin не JSON — код 2, строка прежней команды; без бота — код 1, «бот не настроен»", async () => {
  const desk = new NotifyDesk({
    questions: NO_BOT,
    transcripts: new Transcripts({ files: DISK_FILES, clock: new TestClock() }),
    windows: NO_WINDOWS,
    sessions: new Sessions(new TestClock()),
    clock: new TestClock(),
    diagnose: () => {},
  });
  const told = async (stdin: string) => {
    let stderr = "";
    const reply = await desk.reply(stdin, () => undefined);
    reply.tell({ stdout: () => {}, stderr: (text) => void (stderr += text) });
    return [reply.code(), stderr];
  };
  assertEquals(await told("{"), [
    2,
    await Deno.readTextFile(
      testdata("claude-hook-notification/err-bad-json-stderr.txt"),
    ),
  ]);
  assertEquals(await told('{"notification_type":"auth_success"}'), [
    1,
    "mpu claude-hook notification: бот не настроен\n",
  ]);
  await desk.stop();
});

Deno.test("остановка ядра — снимок «истёк», наблюдение погашено", async () => {
  await withNotify(async ({ bot, clock, tmux, notify, desk }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    await desk.stop();
    await bot.called(2);
    assertEquals(
      bot.calls[1].text.split("\n").at(-1),
      "⌛ истёк — ответьте в терминале",
    );
  });
});
