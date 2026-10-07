/**
 * Вопрос хука `PermissionRequest` целиком: payload → сообщение в чате →
 * решение (`claude-hook-permission-request.md`; сценарии постановки R1b
 * — номерами в именах тестов). Бот — фейк, транскрипт — файл во
 * временном каталоге, часы стола ведёт тест.
 */

import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, beforeAll, describe, expect, it } from "vitest";
import { type Asked, NO_BOT, REAL_CLOCK } from "../botquestions/mod.ts";
import type { HookReply } from "./reply.ts";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
  textUpdate,
} from "../botquestions/testbot.ts";
import { DEADLINE_MS, HOOK_TIMEOUT_S, PermissionDesk } from "./desk.ts";
import { DISK_FILES, Transcripts, WATCH_MS } from "./transcript.ts";
import { NO_WINDOWS, type TmuxRun, Windows } from "./window.ts";
import { Sessions } from "./sessions.ts";
import { TestClock } from "./testclock.ts";

const testdata = (name: string) =>
  new URL(`testdata/permission-request/${name}`, import.meta.url);

/** Живой payload с подменой полей. */
async function livePayload(
  name: string,
  over: Readonly<Record<string, unknown>>,
): Promise<string> {
  const live = JSON.parse(await readFile(testdata(name), "utf8"));
  return JSON.stringify({ ...live, ...over });
}

/** Что напечатал ответ хука. */
interface Told {
  readonly stdout: string;
  readonly stderr: string;
}

/** Транскрипт сессии A: название `mpu-bot`. */
const TITLED = [
  '{"type":"ai-title","aiTitle":"автоназвание"}',
  '{"type":"custom-title","customTitle":"mpu-bot"}',
];

/** Запись `tool_use` вызова `input` инструмента `name`. */
function toolUse(id: string, name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
}

/** Запись ответа `tool_result` на вызов `id`. */
function toolResult(id: string): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
  });
}

/** Стенд стола: бот, транскрипт, окно, часы. */
async function withDesk(
  body: (stand: {
    readonly bot: FakeBot;
    readonly clock: TestClock;
    readonly sessions: Sessions;
    readonly transcript: string;
    readonly append: (line: string) => Promise<void>;
    /** Живой payload: транскрипт — файл стенда, если не подменён. */
    readonly payload: (
      name: string,
      over?: Readonly<Record<string, unknown>>,
    ) => Promise<string>;
    readonly ask: (
      stdin: string,
      env?: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ) => Promise<Told>;
  }) => Promise<void>,
  options: { readonly lines?: readonly string[]; readonly tmux?: TmuxRun } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const transcript = `${dir}/session.jsonl`;
  await writeFile(
    transcript,
    (options.lines ?? TITLED).map((line) => `${line}\n`).join(""),
  );
  const bot = new FakeBot();
  const questions = fakeQuestions(bot);
  const clock = new TestClock();
  const sessions = new Sessions(clock);
  const desk = new PermissionDesk({
    questions,
    transcripts: new Transcripts({ files: DISK_FILES, clock }),
    windows: options.tmux === undefined
      ? NO_WINDOWS
      : new Windows(options.tmux),
    sessions,
    clock,
  });
  questions.start();
  try {
    await body({
      bot,
      clock,
      sessions,
      transcript,
      append: (line) => appendFile(transcript, `${line}\n`),
      payload: (name, over = {}) =>
        livePayload(name, { transcript_path: transcript, ...over }),
      ask: async (stdin, env = {}, signal = new AbortController().signal) => {
        let stdout = "";
        let stderr = "";
        const reply = await desk.reply(stdin, (name) => env[name], signal);
        reply.tell({
          stdout: (text) => void (stdout += text),
          stderr: (text) => void (stderr += text),
        });
        return { stdout, stderr };
      },
    });
  } finally {
    await questions.stop();
    await rm(dir, { recursive: true });
  }
}

/** Решение одной строкой stdout. */
function decision(fields: Readonly<Record<string, unknown>>): string {
  return `${
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: fields,
      },
    })
  }\n`;
}

const UNDECIDED = "mpu claude-hook permission-request: без решения — ";

/** tmux сессии A: окно `w:2 claude`. */
const TMUX_A: TmuxRun = (args) =>
  Promise.resolve(
    JSON.stringify(args) ===
        JSON.stringify([
          "-S",
          "/tmp/tmux-1000/default",
          "display-message",
          "-p",
          "-t",
          "%7",
          "#S:#I #W",
        ])
      ? "w:2 claude\n"
      : undefined,
  );

const TMUX_ENV = { TMUX: "/tmp/tmux-1000/default,4242,0", TMUX_PANE: "%7" };

const BASH_TEXT = "Create probe file\ntouch /tmp/x1.txt";
const BASH_HEAD = "🔐 Bash — mpu-bot · ozon · w:2 claude";

it("1–2: вопрос о праве с вариантами терминала; «Yes» — allow", async () => {
  await withDesk(async ({ bot, ask, payload }) => {
    const told = ask(await payload("live-permission-bash.json"), TMUX_ENV);
    await bot.called(1);
    expect(bot.calls[0]).toStrictEqual({
      method: "send",
      message: 0,
      text: `${BASH_HEAD}\n${BASH_TEXT}`,
      buttons: [["Yes", "Yes, always: Bash(touch /tmp/x1.txt)"], ["No"]],
      data: [["r1:1:0:0", "r1:1:0:1"], ["r1:1:0:2"]],
    });
    bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
    expect(await told).toStrictEqual({
      stdout: decision({ behavior: "allow" }),
      stderr: "",
    });
    await bot.called(3);
    expect(bot.calls[2].text).toStrictEqual(
      `${BASH_HEAD}\n${BASH_TEXT}\n✅ Yes — из чата`,
    );
  }, { tmux: TMUX_A });
});

it("3: подсказка — allow и updatedPermissions как пришла", async () => {
  await withDesk(async ({ bot, ask, payload }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:1")]);
    expect((await told).stdout).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch /tmp/x1.txt"}],"behavior":"allow","destination":"localSettings"}]}}}\n',
    );
    await bot.called(3);
    assert(
      bot.calls[2].text.endsWith(
        "\n✅ Yes, always: Bash(touch /tmp/x1.txt) — из чата",
      ),
      bot.calls[2].text,
    );
  });
});

describe("4–5: «No» — deny; текст владельца — deny с пояснением", () => {
  it("кнопка No", () =>
    withDesk(async ({ bot, ask, payload }) => {
      const told = ask(await payload("live-permission-bash.json"));
      await bot.called(1);
      bot.deliver([pressUpdate(1, 111, "r1:1:0:2")]);
      expect((await told).stdout).toStrictEqual(decision({ behavior: "deny" }));
      await bot.called(3);
      assert(bot.calls[2].text.endsWith("\n❌ No — из чата"));
    }));
  it("текст", () =>
    withDesk(async ({ bot, ask, payload }) => {
      const told = ask(await payload("live-permission-bash.json"));
      await bot.called(1);
      bot.deliver([textUpdate(1, 111, "не трогай /tmp", 1)]);
      expect((await told).stdout).toStrictEqual(
        decision({ behavior: "deny", message: "не трогай /tmp" }),
      );
      await bot.called(2);
      assert(
        bot.calls[1].text.endsWith("\n❌ No: не трогай /tmp — из чата"),
        bot.calls[1].text,
      );
    }));
});

/** Транскрипт сессии A с `tool_use` вызова из живого payload'а. */
async function bashLines(id: string): Promise<readonly string[]> {
  const live = JSON.parse(
    await readFile(testdata("live-permission-bash.json"), "utf8"),
  );
  // Порядок ключей в транскрипте другой, чем в payload: равенство — по
  // значению.
  const input = {
    description: live.tool_input.description,
    command: live.tool_input.command,
  };
  return [...TITLED, toolUse(id, "Bash", input)];
}

it("6: tool_result вызова в транскрипте — снят «решено в терминале»", async () => {
  await withDesk(async ({ bot, clock, append, ask, payload }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(WATCH_MS);
    await append(toolResult("toolu_A"));
    clock.fire(WATCH_MS);
    expect(await told).toStrictEqual({
      stdout: "",
      stderr: `${UNDECIDED}решено в терминале\n`,
    });
    await bot.called(2);
    assert(bot.calls[1].text.endsWith("\n✅ решено в терминале"));
    // Снятие — не позже 2 с: хвост смотрится чаще.
    assert(WATCH_MS <= 2000);
    expect(clock.asked.includes(WATCH_MS)).toBe(true);
  }, { lines: await bashLines("toolu_A") });
});

it("D.5: соседний tool_result и недописанная строка вопрос не снимают", async () => {
  await withDesk(async ({ bot, clock, append, transcript, ask, payload }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(WATCH_MS);
    await append(toolResult("toolu_other"));
    // Ответ на наш вызов, ещё без перевода строки: строка не дописана.
    await appendFile(transcript, toolResult("toolu_A"));
    await turn(clock, told);
    expect(bot.calls.length).toBe(1);
    await appendFile(transcript, "\n");
    await withdrawnBy(clock, told);
  }, { lines: await bashLines("toolu_A") });
});

/**
 * Один оборот наблюдателя после дописанного: пауза кончается, хвост
 * прочитан, наблюдатель встал на следующую паузу (или вопрос снят).
 */
async function turn(clock: TestClock, told: Promise<Told>): Promise<void> {
  clock.fire(WATCH_MS);
  const first = await Promise.race([
    told.then(() => "снят"),
    clock.paused(WATCH_MS).then(() => "ждёт"),
  ]);
  expect(first, "вопрос снят раньше ответа на свой вызов").toBe("ждёт");
}

/**
 * Оборот после записи ответа: вопрос обязан сняться за него. Не снялся —
 * наблюдатель встаёт на следующую паузу, и тест краснеет, а не висит.
 */
async function withdrawnBy(clock: TestClock, told: Promise<Told>) {
  clock.fire(WATCH_MS);
  const first = await Promise.race([told, clock.paused(WATCH_MS)]);
  expect(first).toStrictEqual({
    stdout: "",
    stderr: `${UNDECIDED}решено в терминале\n`,
  });
}

it("R1c-1: tool_use дописан после постановки — снятие по его tool_result", async () => {
  const [use] = (await bashLines("toolu_A")).slice(-1);
  await withDesk(async ({ bot, clock, append, payload, ask }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(WATCH_MS);
    await append(use);
    await turn(clock, told);
    expect(bot.calls.length).toBe(1);
    await append(toolResult("toolu_A"));
    // Снятие — одним оборотом после записи ответа: не позже 2 с.
    await withdrawnBy(clock, told);
  });
});

it("R1c-2: старый вызов с ответом — чужой; новый, дописанный, — вызов вопроса", async () => {
  const old = await bashLines("toolu_A");
  const [use] = (await bashLines("toolu_B")).slice(-1);
  await withDesk(async ({ bot, clock, append, payload, ask }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(WATCH_MS);
    await append(use);
    await turn(clock, told);
    expect(bot.calls.length).toBe(1);
    await append(toolResult("toolu_B"));
    await withdrawnBy(clock, told);
  }, { lines: [...old, toolResult("toolu_A")] });
});

it("R1c-3: старый вызов с ответом, нового нет — вопрос не снимается", async () => {
  const lines = [...await bashLines("toolu_A"), toolResult("toolu_A")];
  await withDesk(async ({ bot, clock, append, payload, ask }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(WATCH_MS);
    await append(toolResult("toolu_A"));
    await turn(clock, told);
    expect(bot.calls.length).toBe(1);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
    expect((await told).stdout).toStrictEqual(decision({ behavior: "allow" }));
  }, { lines });
});

it("R1c: id вызова повторён в файле — ответ закрывает все вхождения", async () => {
  const old = await bashLines("toolu_A");
  const lines = [...old, old.at(-1) ?? "", toolResult("toolu_A")];
  await withDesk(async ({ bot, clock, append, payload, ask }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(WATCH_MS);
    await append(toolResult("toolu_A"));
    await turn(clock, told);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
    expect((await told).stdout).toStrictEqual(decision({ behavior: "allow" }));
  }, { lines });
});

it("R1c-5: два открытых одинаковых вызова — вопрос у самого раннего", async () => {
  const [useD] = (await bashLines("toolu_D")).slice(-1);
  const lines = [...await bashLines("toolu_C"), useD];
  await withDesk(async ({ bot, clock, append, payload, ask }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(WATCH_MS);
    await append(toolResult("toolu_D"));
    await turn(clock, told);
    expect(bot.calls.length).toBe(1);
    await append(toolResult("toolu_C"));
    await withdrawnBy(clock, told);
  }, { lines });
});

it("7 (S10): несколько вариантов — галочки, «Готово», answers через «, »", async () => {
  await withDesk(async ({ bot, ask, payload }) => {
    const stdin = await payload("live-permission-ask-user-question-multi.json");
    const told = ask(stdin);
    await bot.called(1);
    expect(bot.calls[0].text.split("\n")[0]).toBe("❓ Размер — mpu-bot · ozon");
    expect(bot.calls[0].buttons).toStrictEqual([["☐ S", "☐ M"], ["Готово"]]);
    bot.deliver([
      pressUpdate(1, 111, "r1:1:0:0"),
      pressUpdate(2, 111, "r1:1:0:1"),
      pressUpdate(3, 111, "r1:1:0:ok"),
    ]);
    expect((await told).stdout).toStrictEqual(decision({
      behavior: "allow",
      updatedInput: {
        questions: JSON.parse(stdin).tool_input.questions,
        answers: { "Какой размер?": "S, M" },
      },
    }));
  });
});

it("8 (S12), R2a-10: два вопроса — два шага, заголовок шага — свой header, answers обоих одним решением", async () => {
  await withDesk(async ({ bot, ask, payload }) => {
    const questions = [
      {
        question: "Какой цвет?",
        header: "Цвет",
        options: [{ label: "Красный" }, { label: "Синий" }],
        multiSelect: false,
      },
      {
        question: "Какой размер?",
        header: "Размер",
        options: [{ label: "S" }, { label: "M" }],
        multiSelect: false,
      },
    ];
    const told = ask(
      await payload("live-permission-ask-user-question-single.json", {
        tool_input: { questions },
      }),
    );
    await bot.called(1);
    expect(bot.calls[0].text.split("\n")[0]).toBe(
      "❓ Цвет 1/2 — mpu-bot · ozon",
    );
    bot.deliver([pressUpdate(1, 111, "r1:1:0:1")]);
    await bot.called(3);
    expect(bot.calls[2].text.split("\n")[0]).toBe(
      "❓ Размер 2/2 — mpu-bot · ozon",
    );
    bot.deliver([textUpdate(2, 111, "XL", 1)]);
    expect((await told).stdout).toStrictEqual(decision({
      behavior: "allow",
      updatedInput: {
        questions,
        answers: { "Какой цвет?": "Синий", "Какой размер?": "XL" },
      },
    }));
  });
});

describe("9 (S8): вне tmux и без названия — только проект; ничего — голова", () => {
  it("cwd sl-back", () =>
    withDesk(async ({ bot, ask, payload }) => {
      const told = ask(
        await payload("live-permission-bash.json", {
          cwd: "/home/user/mr/mp/sl-back/",
        }),
        { TMUX_PANE: "%7" },
      );
      await bot.called(1);
      expect(bot.calls[0].text.split("\n")[0]).toBe("🔐 Bash — sl-back");
      bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
      await told;
    }, { lines: [], tmux: TMUX_A }));
  it("ничего «откуда»", () =>
    withDesk(async ({ bot, ask, payload }) => {
      const told = ask(
        await payload("live-permission-bash.json", {
          cwd: 7,
          transcript_path: "/нет/такого.jsonl",
        }),
      );
      await bot.called(1);
      expect(bot.calls[0].text.split("\n")[0]).toBe("🔐 Bash");
      bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
      await told;
    }));
});

describe("заголовок: MCP-тул, автоназвание, длинное название", () => {
  const cases: readonly [string, readonly string[], string][] = [
    ["mcp__mpu__mpu", TITLED, "🔐 mpu (MCP) — mpu-bot · ozon"],
    [
      "Bash",
      ['{"type":"ai-title","aiTitle":"Починка логина"}'],
      "🔐 Bash — Починка логина · ozon",
    ],
    [
      "Bash",
      ['{"type":"custom-title","customTitle":"очень-длинное-имя-сессии-claude"}'],
      "🔐 Bash — очень-длинное-имя-сесси… · ozon",
    ],
  ];
  for (const [tool, lines, head] of cases) {
    it(head, () =>
      withDesk(async ({ bot, ask, payload }) => {
        const told = ask(
          await payload("live-permission-bash.json", { tool_name: tool }),
        );
        await bot.called(1);
        expect(bot.calls[0].text.split("\n")[0]).toStrictEqual(head);
        bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
        await told;
      }, { lines }));
  }
});

it("11 (S18): срок ядра — «истёк срок ожидания», сообщение «истёк»", async () => {
  expect(DEADLINE_MS).toBe(3_540_000);
  await withDesk(async ({ bot, clock, ask, payload }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(DEADLINE_MS);
    clock.fire(DEADLINE_MS);
    expect(await told).toStrictEqual({
      stdout: "",
      stderr: `${UNDECIDED}истёк срок ожидания\n`,
    });
    await bot.called(2);
    assert(bot.calls[1].text.endsWith("\n⌛ истёк — ответьте в терминале"));
  });
});

it("11: обрыв строки — исход «истёк»", async () => {
  await withDesk(async ({ bot, ask, payload }) => {
    const gone = new AbortController();
    const told = ask(
      await payload("live-permission-bash.json"),
      {},
      gone.signal,
    );
    await bot.called(1);
    gone.abort();
    expect((await told).stderr).toStrictEqual(
      `${UNDECIDED}истёк срок ожидания\n`,
    );
  });
});

it("срок хука во фрагменте — тот, из которого выведен срок ядра", async () => {
  const fragment = JSON.parse(
    await readFile(testdata("settings-fragment.json"), "utf8"),
  );
  const timeout = fragment.hooks.PermissionRequest[0].hooks[0].timeout;
  expect(timeout).toStrictEqual(HOOK_TIMEOUT_S);
  expect(DEADLINE_MS).toStrictEqual((timeout - 60) * 1000);
});

it("10 (S16): бот не настроен — без решения, файлов не ждёт", async () => {
  const desk = new PermissionDesk({
    questions: NO_BOT,
    transcripts: new Transcripts({ files: DISK_FILES, clock: new TestClock() }),
    windows: NO_WINDOWS,
    sessions: new Sessions(new TestClock()),
    clock: new TestClock(),
  });
  let stderr = "";
  const reply = await desk.reply(
    await livePayload("live-permission-bash.json", {}),
    () => undefined,
    new AbortController().signal,
  );
  reply.tell({ stdout: () => {}, stderr: (text) => void (stderr += text) });
  expect(stderr).toStrictEqual(`${UNDECIDED}бот не настроен\n`);
});

it("голден транскрипта: название — последнее custom-title; ответ в терминале снимает", async () => {
  const lines = (await readFile(
    testdata("transcript-titles-and-ask-answered.jsonl"),
    "utf8",
  )).trimEnd().split("\n");
  // Порядок пробы 10: `tool_use` записан до вопроса, `tool_result` из
  // терминала дописывается во время ожидания. Живая проба 2026-10-06
  // показала и обратный: `tool_use` после постановки (тесты R1c).
  const asked = lines.slice(0, 4);
  const answered = lines[4];
  const input = JSON.parse(asked[3]).message.content[0].input;
  await withDesk(async ({ bot, clock, append, payload, ask }) => {
    // В payload `multiSelect` — после `options`, в транскрипте — до:
    // равенство входа — по значению.
    const [question] = input.questions;
    const told = ask(
      await payload("live-permission-ask-user-question-single.json", {
        tool_input: {
          questions: [{
            question: question.question,
            header: question.header,
            options: question.options,
            multiSelect: question.multiSelect,
          }],
        },
      }),
    );
    await bot.called(1);
    expect(bot.calls[0].text.split("\n")[0]).toBe("❓ День — mpu-bot · ozon");
    await clock.paused(WATCH_MS);
    await append(answered);
    await withdrawnBy(clock, told);
  }, { lines: asked });
});

it("живая подсказка Read //dev/** — подпись и updatedPermissions", async () => {
  await withDesk(async ({ bot, payload, ask }) => {
    const stdin = await payload("live-permission-bash-dev-suggestion.json");
    const told = ask(stdin);
    await bot.called(1);
    expect(bot.calls[0].buttons).toStrictEqual([
      ["Yes", "Yes, always: Read(//dev/**)"],
      ["No"],
    ]);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:1")]);
    expect((await told).stdout).toStrictEqual(decision({
      behavior: "allow",
      updatedPermissions: JSON.parse(stdin).permission_suggestions,
    }));
  });
});

describe("строка оборвана до вопроса и остановка ядра — «истёк» сразу, на настоящих часах", () => {
  let stdin: string;
  beforeAll(async () => {
    stdin = await livePayload("live-permission-bash.json", {
      transcript_path: testdata("transcript-titles-and-ask-answered.jsonl")
        .pathname,
    });
  });
  const make = (bot: FakeBot) =>
    new PermissionDesk({
      questions: fakeQuestions(bot),
      transcripts: new Transcripts({ files: DISK_FILES, clock: REAL_CLOCK }),
      windows: NO_WINDOWS,
      sessions: new Sessions(REAL_CLOCK),
      clock: REAL_CLOCK,
    });
  const expired = `${UNDECIDED}истёк срок ожидания\n`;
  const stderrOf = async (reply: Promise<HookReply>) => {
    let stderr = "";
    (await reply).tell({
      stdout: () => {},
      stderr: (text) => void (stderr += text),
    });
    return stderr;
  };
  it("сигнал строки уже прерван", async () => {
    const gone = new AbortController();
    gone.abort();
    const bot = new FakeBot();
    expect(await stderrOf(make(bot).reply(stdin, () => undefined, gone.signal)))
      .toStrictEqual(expired);
    expect(bot.calls).toStrictEqual([]);
  });
  it("стол остановлен до вопроса", async () => {
    const bot = new FakeBot();
    const desk = make(bot);
    desk.stop();
    expect(
      await stderrOf(
        desk.reply(stdin, () => undefined, new AbortController().signal),
      ),
    ).toStrictEqual(expired);
    expect(bot.calls).toStrictEqual([]);
  });
});

it("транскрипт перестал читаться во время ожидания — ответ из чата доходит", async () => {
  await withDesk(async ({ bot, clock, transcript, payload, ask }) => {
    const told = ask(await payload("live-permission-bash.json"));
    await bot.called(1);
    await clock.paused(WATCH_MS);
    await chmod(transcript, 0o000);
    clock.fire(WATCH_MS);
    await clock.paused(WATCH_MS);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
    expect(await told).toStrictEqual({
      stdout: decision({ behavior: "allow" }),
      stderr: "",
    });
    await chmod(transcript, 0o600);
  }, { lines: await bashLines("toolu_A") });
});

/**
 * Занята ли сессия `socket` вопросом: снимок не ставится. Пробный снимок,
 * если встал, тут же уходит.
 */
function busy(sessions: Sessions, socket: string): boolean {
  const session = sessions.of(socket);
  const probe: Asked = {
    outcome: new Promise(() => {}),
    placed: Promise.resolve(),
    withdraw: () => {},
    withdrawAs: () => {},
    expire: () => {},
  };
  return session.snapshot(() => probe, {
    seated: (asked) => {
      session.leave(asked);
      return false;
    },
    busy: () => true,
  });
}

it("R4-7: вопрос о праве — вопрос своей сессии в ряду, пока не решён", async () => {
  await withDesk(async ({ bot, ask, payload, sessions }) => {
    const socket = "/run/user/1000/cc-socks/9.sock";
    const told = ask(await payload("live-permission-bash.json"), {
      CLAUDE_CODE_MESSAGING_SOCKET: socket,
    });
    await bot.called(1);
    expect(busy(sessions, socket)).toBe(true);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
    await told;
    expect(busy(sessions, socket)).toBe(false);
  });
});
