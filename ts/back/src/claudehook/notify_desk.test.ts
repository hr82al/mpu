/**
 * Хук `Notification` в ядре (`claude-hook-notification-snapshot.md`;
 * строка-уведомление — `claude-hook-notification.md`; сценарии постановки
 * R4 — номерами в именах тестов). tmux — фейк по снятым экранам, бот —
 * фейк, часы — теста.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
import { LOOK_MS, NOTHING_SENT, SETTLE_MS } from "./snapshot.ts";
import { TestClock } from "./testclock.ts";
import { DISK_FILES, type TranscriptFiles, Transcripts } from "./transcript.ts";
import { NO_WINDOWS, Windows } from "./window.ts";

const testdata = (name: string) => new URL(`testdata/${name}`, import.meta.url);

const screen = (name: string) => readFile(testdata(`snapshot/${name}`), "utf8");

/** Формат вопроса tmux «что идёт в окне». */
const PANE_COMMAND = "#{pane_current_command}";

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
  /** Сбой самого tmux (не «окно закрыто»): бросает. */
  broken = false;
  /** Что идёт в окне (`#{pane_current_command}`): Claude Code — `claude`. */
  command = "claude";
  /** Подписи окна по порядку: за подписью сразу — постановка снимка. */
  captions = 0;
  readonly #captioned: { count: number; done: () => void }[] = [];

  /** Ждёт `count`-ю подпись окна. */
  captioned(count: number): Promise<void> {
    if (this.captions >= count) return Promise.resolve();
    const reached = Promise.withResolvers<void>();
    this.#captioned.push({ count, done: reached.resolve });
    return reached.promise;
  }

  run = (args: readonly string[]): Promise<string | undefined> => {
    if (!this.alive) return Promise.resolve(undefined);
    if (this.broken) return Promise.reject(new Error("tmux упал"));
    const command = args[2];
    if (command === "display-message" && args.at(-1) === PANE_COMMAND) {
      return Promise.resolve(`${this.command}\n`);
    }
    if (command === "display-message") {
      this.captions += 1;
      for (const one of this.#captioned) {
        if (this.captions >= one.count) one.done();
      }
      return Promise.resolve("w:9 probe\n");
    }
    if (command === "capture-pane") {
      this.captures += 1;
      return Promise.resolve(this.screen);
    }
    this.sent.push([...args]);
    return Promise.resolve("");
  };
}

/**
 * Файлы транскриптов под правами ядра: пустой путь — отказ
 * `Empty path is not allowed` (снято на узком `--allow-read`; под
 * широкими правами теста Deno ответил бы `NotFound`).
 */
const KERNEL_FILES: TranscriptFiles = {
  read: (path) =>
    path === ""
      ? Promise.reject(new Error("Empty path is not allowed"))
      : DISK_FILES.read(path),
  readFrom: DISK_FILES.readFrom,
};

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
      over?: Readonly<Record<string, unknown>>,
    ) => Promise<Told>;
    readonly desk: NotifyDesk;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const transcript = `${dir}/session.jsonl`;
  await writeFile(
    transcript,
    '{"type":"custom-title","customTitle":"probe"}\n',
  );
  const live = JSON.parse(
    await readFile(
      testdata("claude-hook-notification/live-payload-idle-prompt.json"),
      "utf8",
    ),
  );
  const bot = new FakeBot();
  const questions = fakeQuestions(bot);
  const clock = new TestClock();
  const tmux = new FakeTmux();
  const sessions = new Sessions(clock);
  const desk = new NotifyDesk({
    questions,
    transcripts: new Transcripts({ files: KERNEL_FILES, clock }),
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
      notify: async (type, env = ENV, over = {}) => {
        let stdout = "";
        let stderr = "";
        const reply = await desk.reply(
          JSON.stringify({
            ...live,
            notification_type: type,
            transcript_path: transcript,
            ...over,
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
    await rm(dir, { recursive: true });
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

it("R4-1: ожидание права с окном — через 3 с снимок: тело, жирная первая строка, кнопки", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    expect(await notify("permission_prompt")).toStrictEqual(SILENT);
    expect(bot.calls).toStrictEqual([]);
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
    expect(bot.calls[0].text).toStrictEqual(`${HEAD}\n${body}`);
    expect(bot.calls[0].entities).toStrictEqual([
      { type: "bold", offset: HEAD.length + 1, length: "Bash command".length },
    ]);
    expect(bot.calls[0].buttons).toStrictEqual([
      ["1. Yes"],
      ["2. Yes, and don’t ask again for: touch *"],
      ["3. Yes, and switch to auto mode"],
      ["4. No"],
      ["⏎", "⎋", "↑", "↓"],
      ["весь экран"],
    ]);
  });
});

describe("R4-2, R4-3: AskUserQuestion — пункты с описанием; форма MCP — кнопки только клавиши", () => {
  it(
    "AskUserQuestion",
    () =>
      withNotify(async ({ bot, clock, tmux, notify }) => {
        tmux.screen = await screen("screen-ask-user-question.txt");
        await notify("permission_prompt");
        await placed(clock, bot);
        expect(bot.calls[0].text.split("\n").slice(1)).toStrictEqual([
          "☐ Цвет",
          "Какой цвет?",
          "1. Красный — Красный цвет",
          "2. Синий — Синий цвет",
          "3. Type something.",
          "4. Chat about this",
        ]);
        expect(bot.calls[0].buttons.slice(0, 4)).toStrictEqual([
          ["1. Красный"],
          ["2. Синий"],
          ["3. Type something."],
          ["4. Chat about this"],
        ]);
      }),
  );
  it("форма MCP", () =>
    withNotify(async ({ bot, clock, tmux, notify }) => {
      tmux.screen = await screen("screen-elicitation-fields.txt");
      await notify("permission_prompt");
      await placed(clock, bot);
      expect(bot.calls[0].buttons).toStrictEqual([["⏎", "⎋", "↑", "↓"], [
        "весь экран",
      ]]);
    }));
});

it("R4-4: нажатие «2» — send-keys 2, через 1 с диалога нет — «✅ окно сменилось», кнопок нет", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:1")]);
    await clock.paused(SETTLE_MS);
    expect(tmux.sent).toStrictEqual([[
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
    expect(bot.calls[2].text.split("\n").at(-1)).toBe(
      "✅ окно сменилось — лента",
    );
    expect(bot.calls[2].buttons).toStrictEqual([]);
  });
});

it("R4-5: блок сменился без нажатия — «✅ решено в терминале»; тот же — не снят", async () => {
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
    expect(first).toBe("ждёт");
    tmux.screen = await screen("screen-ask-user-question.txt");
    clock.fire(LOOK_MS);
    await bot.called(2);
    expect(bot.calls[1].text.split("\n").at(-1)).toBe("✅ решено в терминале");
  });
});

it("R4-6: tmux не отвечает — «⌛ окно недоступно»", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    await clock.paused(LOOK_MS);
    tmux.alive = false;
    clock.fire(LOOK_MS);
    await bot.called(2);
    expect(bot.calls[1].text.split("\n").at(-1)).toBe("⌛ окно недоступно");
  });
});

describe("R4-7, R4-8: у сессии есть вопрос в ряду — снимка нет", () => {
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
        "trust_prompt",
        (
          sessions: Sessions,
          ask: () => ReturnType<ReturnType<typeof fakeQuestions>["ask"]>,
        ) => sessions.of(SOCKET).replace(ask),
      ],
    ] as const
  ) {
    it(name, () =>
      withNotify(
        async ({ bot, clock, tmux, notify, sessions, questions }) => {
          tmux.screen = await screen("screen-permission-bash.txt");
          expect(await notify(type)).toStrictEqual(SILENT);
          seat(sessions, () => questions.ask(f1()));
          await bot.called(1);
          await clock.paused(SETTLE_QUESTION_MS);
          clock.fire(SETTLE_QUESTION_MS);
          // Снимок, вставший в ряд за вопросом сессии, проявился бы
          // правкой «ещё ждут» у её вопроса: подпись окна — и сразу
          // решение; правки ряда дописаны остановкой службы вопросов.
          await tmux.captioned(1);
          await questions.stop();
          expect(bot.calls.some((call) => call.text.includes("ещё ждут"))).toBe(
            false,
          );
        },
      ));
  }
});

it("R4-9: trust_prompt без вопроса, окно известно — снимок", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("trust_prompt");
    await placed(clock, bot);
    expect(bot.calls[0].text.startsWith("🖥 probe")).toBe(true);
  });
});

describe("R4-10, R4-11: без окна и не ожидание — строка-уведомление сразу, stdout — номер", () => {
  for (
    const [name, type, env] of [
      ["ожидание без TMUX_PANE", "trust_prompt", {
        CLAUDE_CODE_MESSAGING_SOCKET: SOCKET,
      }],
      ["auth_success", "auth_success", ENV],
    ] as const
  ) {
    it(name, () =>
      withNotify(async ({ bot, notify }) => {
        expect(await notify(type, env)).toStrictEqual({
          stdout: '{"id": 1546}\n',
          stderr: "",
          code: 0,
        });
        expect(bot.calls[0].text).toStrictEqual(
          `Claude · ozon · ${type}\nClaude is waiting for your input`,
        );
        expect(bot.calls[0].buttons).toStrictEqual([]);
      }));
  }
});

it("R4-12: текст владельца — send-keys -l <текст> и Enter", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-ask-user-question.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    bot.deliver([textUpdate(1, 111, "Зелёный", 1)]);
    await clock.paused(SETTLE_MS);
    expect(tmux.sent).toStrictEqual([
      [
        "-S",
        "/tmp/tmux-1000/default",
        "send-keys",
        "-t",
        "%9",
        "-l",
        "--",
        "Зелёный",
      ],
      ["-S", "/tmp/tmux-1000/default", "send-keys", "-t", "%9", "Enter"],
    ]);
  });
});

it("R4-13: «весь экран» — отдельное сообщение моноширинным блоком, без кнопок", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-elicitation-fields.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:15")]);
    await bot.called(3);
    const whole = bot.calls[2];
    expect(whole.method).toBe("send");
    expect(whole.buttons).toStrictEqual([]);
    expect(whole.text).toStrictEqual(tmux.screen.trimEnd());
    expect(whole.entities).toStrictEqual([{
      type: "pre",
      offset: 0,
      length: whole.text.length,
    }]);
  });
});

it("структурный вопрос сессии после снимка — снимок «↷ вопрос в чате»", async () => {
  await withNotify(
    async ({ bot, clock, tmux, notify, sessions, questions }) => {
      tmux.screen = await screen("screen-permission-bash.txt");
      await notify("permission_prompt");
      await placed(clock, bot);
      const asked = sessions.of(SOCKET).urgent(() => questions.ask(f1()));
      await bot.called(3);
      expect(bot.calls[1].text.split("\n").at(-1)).toBe("↷ вопрос в чате");
      asked.expire();
    },
  );
});

it("stdin не JSON — код 2, строка прежней команды; без бота — код 1, «бот не настроен»", async () => {
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
  expect(await told("{")).toStrictEqual([
    2,
    await readFile(
      testdata("claude-hook-notification/err-bad-json-stderr.txt"),
      "utf8",
    ),
  ]);
  expect(await told('{"notification_type":"auth_success"}')).toStrictEqual([
    1,
    "mpu claude-hook notification: бот не настроен\n",
  ]);
  await desk.stop();
});

it("остановка ядра — снимок «истёк», наблюдение погашено", async () => {
  await withNotify(async ({ bot, clock, tmux, notify, desk }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    await desk.stop();
    await bot.called(2);
    expect(bot.calls[1].text.split("\n").at(-1)).toBe(
      "⌛ истёк — ответьте в терминале",
    );
  });
});

it("кнопка прежнего блока и второе касание — в новый блок вслепую не жмут", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-ask-user-question.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    // Два касания «1» подряд: второе заказано по тому же блоку.
    bot.deliver([
      pressUpdate(1, 111, "r1:1:0:0"),
      pressUpdate(2, 111, "r1:1:0:0"),
    ]);
    await clock.paused(SETTLE_MS);
    tmux.screen = await screen("screen-permission-bash.txt");
    clock.fire(SETTLE_MS);
    await bot.called(4);
    // Блок сменился: сообщение — новым блоком, клавиша ушла одна.
    expect(bot.calls[3].text.split("\n")[1]).toBe("Bash command");
    await clock.paused(LOOK_MS);
    expect(tmux.sent.length).toBe(1);
    // Кнопка прежнего блока (поколение 0) — «вопрос уже решён».
    bot.deliver([pressUpdate(3, 111, "r1:1:0:1")]);
    await bot.called(5);
    expect(bot.calls[4]).toStrictEqual({
      method: "ack",
      message: 0,
      text: "вопрос уже решён",
      buttons: [],
      data: [],
    });
    expect(tmux.sent.length).toBe(1);
  });
});

it("второе уведомление той же сессии — снимок один", async () => {
  await withNotify(async ({ bot, clock, tmux, notify, questions }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    await notify("permission_prompt");
    await clock.paused(SETTLE_QUESTION_MS);
    clock.fire(SETTLE_QUESTION_MS);
    // Подпись окна второго решения; сразу за ней — постановка или отказ,
    // без ожидания. Правки ряда дописаны остановкой службы вопросов.
    await tmux.captioned(2);
    await questions.stop();
    expect(bot.calls.filter((call) => call.method === "send").length).toBe(1);
    expect(bot.calls.some((call) => call.text.includes("ещё ждут"))).toBe(
      false,
    );
  });
});

it("на экране нет диалога — строка-уведомление вместо снимка", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = "● Готово.\n";
    await notify("trust_prompt");
    await placed(clock, bot);
    expect(bot.calls[0].text).toBe(
      "Claude · ozon · trust_prompt\nClaude is waiting for your input",
    );
    expect(bot.calls[0].buttons).toStrictEqual([]);
  });
});

describe("незнакомый тип и тип не задан — строка-уведомление, как прежде", () => {
  for (
    const [name, type, head] of [
      ["незнакомый", "brand_new_event", "Claude · ozon · brand_new_event"],
      ["не задан", "", "Claude · ozon · notification"],
    ] as const
  ) {
    it(name, () =>
      withNotify(async ({ bot, notify }) => {
        expect((await notify(type)).code).toBe(0);
        expect(bot.calls[0].text.split("\n")[0]).toStrictEqual(head);
      }));
  }
});

it("сбой tmux во время наблюдения — у снимка исход «истёк», ряд не держит", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    await clock.paused(LOOK_MS);
    tmux.broken = true;
    clock.fire(LOOK_MS);
    await bot.called(2);
    expect(bot.calls[1].text.split("\n").at(-1)).toBe(
      "⌛ истёк — ответьте в терминале",
    );
    expect(bot.calls[1].buttons).toStrictEqual([]);
  });
});

it("R3d-1: elicitation_dialog (живой payload) — ни снимка, ни строки: форму закрывают хуки R3", async () => {
  await withNotify(async ({ bot, clock, tmux, desk }) => {
    tmux.screen = await screen("screen-elicitation-fields.txt");
    const live = await readFile(
      new URL(
        "../../../docs/specs/fixtures/telegram-relay/r4/live-notification-elicitation-dialog.json",
        import.meta.url,
      ),
      "utf8",
    );
    let said = "";
    const reply = await desk.reply(
      live,
      (name) => ENV[name as keyof typeof ENV],
    );
    reply.tell({
      stdout: (text) => void (said += text),
      stderr: (text) => void (said += text),
    });
    expect([reply.code(), said]).toStrictEqual([0, ""]);
    // Снимок не ждётся вовсе: паузы 3 с нет, окно не снимается.
    expect(clock.asked).toStrictEqual([]);
    expect(tmux.captures).toBe(0);
    expect(bot.calls).toStrictEqual([]);
  });
});

describe("idle_prompt (живой payload) и elicitation_response — в чат ничего, код 0", () => {
  for (
    const [name, over] of [
      ["idle_prompt", {}],
      ["elicitation_response", {
        message: 'Elicitation response for server "elicitprobe": cancel',
        notification_type: "elicitation_response",
      }],
    ] as const
  ) {
    it(name, () =>
      withNotify(async ({ bot, clock, tmux, desk }) => {
        tmux.screen = await screen("screen-permission-bash.txt");
        const live = JSON.parse(
          await readFile(
            testdata("claude-hook-notification/live-payload-idle-prompt.json"),
            "utf8",
          ),
        );
        const reply = await desk.reply(
          JSON.stringify({ ...live, ...over }),
          (name) => ENV[name as keyof typeof ENV],
        );
        let said = "";
        reply.tell({
          stdout: (text) => void (said += text),
          stderr: (text) => void (said += text),
        });
        expect([reply.code(), said]).toStrictEqual([0, ""]);
        // Ни строки сразу, ни снимка потом: паузы 3 с нет, окно не снято.
        expect(clock.asked).toStrictEqual([]);
        expect(tmux.captures).toBe(0);
        expect(bot.calls).toStrictEqual([]);
      }));
  }
});

const CLAUDE_LEFT = "✅ окно сменилось — Claude Code закрыт";

it("охрана окна 1: в окне bash — текст владельца в окно не уходит, исход и ответ владельцу", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-ask-user-question.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    tmux.command = "bash";
    bot.deliver([textUpdate(1, 111, "q", 1)]);
    await bot.called(3);
    expect(tmux.sent).toStrictEqual([]);
    const said = bot.calls.slice(1).map((call) => call.text.split("\n").at(-1));
    expect(said.toSorted()).toStrictEqual([
      CLAUDE_LEFT,
      "окно уже не Claude Code — ничего не отправлено",
    ].toSorted());
  });
});

it("охрана окна 2: в окне bash — кнопка-клавиша не нажимается, исход «Claude Code закрыт»", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    tmux.command = "bash";
    bot.deliver([pressUpdate(1, 111, "r1:1:0:1")]);
    await bot.called(3);
    expect(tmux.sent).toStrictEqual([]);
    expect(bot.calls[2].text.split("\n").at(-1)).toStrictEqual(CLAUDE_LEFT);
    expect(bot.calls[2].buttons).toStrictEqual([]);
  });
});

it("охрана окна 3: проверка раз в 2 с видит bash при прежнем экране — исход без действий владельца", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    await clock.paused(LOOK_MS);
    tmux.command = "bash";
    clock.fire(LOOK_MS);
    await bot.called(2);
    expect(bot.calls[1].text.split("\n").at(-1)).toStrictEqual(CLAUDE_LEFT);
    expect(tmux.sent).toStrictEqual([]);
  });
});

it("охрана окна 4: перед показом в окне bash — снимка нет, строка-уведомление", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-permission-bash.txt");
    tmux.command = "bash";
    await notify("trust_prompt");
    await placed(clock, bot);
    expect(bot.calls[0].text).toBe(
      "Claude · ozon · trust_prompt\nClaude is waiting for your input",
    );
    expect(bot.calls[0].buttons).toStrictEqual([]);
  });
});

describe("охрана окна 6: transcript_path пуст или нет — снимок без названия сессии, код 0", () => {
  for (
    const [name, over] of [
      ["пуст", { transcript_path: "" }],
      ["нет", { transcript_path: undefined }],
    ] as const
  ) {
    it(name, () =>
      withNotify(async ({ bot, clock, tmux, notify }) => {
        tmux.screen = await screen("screen-permission-bash.txt");
        expect(await notify("permission_prompt", ENV, over)).toStrictEqual(
          SILENT,
        );
        await placed(clock, bot);
        expect(bot.calls[0].text.split("\n")[0]).toBe("🖥 ozon — w:9 probe");
      }));
  }
});

it("охрана окна: «q» ушёл, Claude Code закрылся, кадр остался — через 1 с исход «Claude Code закрыт»", async () => {
  await withNotify(async ({ bot, clock, tmux, notify }) => {
    tmux.screen = await screen("screen-ask-user-question.txt");
    await notify("permission_prompt");
    await placed(clock, bot);
    bot.deliver([textUpdate(1, 111, "q", 1)]);
    await clock.paused(SETTLE_MS);
    expect(tmux.sent.length).toBe(2);
    // Живьём: последний кадр Claude Code остаётся на экране.
    tmux.command = "bash";
    clock.fire(SETTLE_MS);
    await bot.called(2);
    expect(bot.calls[1].text.split("\n").at(-1)).toStrictEqual(CLAUDE_LEFT);
    expect(bot.calls.some((call) => call.text === NOTHING_SENT)).toBe(false);
  });
});
