/**
 * Форма MCP-сервера целиком: payload → шаги в чате → решение
 * (`claude-hook-elicitation.md`; сценарии постановки R3 — номерами в
 * именах тестов). Бот — фейк, часы стола ведёт тест.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NO_BOT } from "../botquestions/mod.ts";
import { BotFailure } from "../botquestions/bot_api.ts";
import {
  f1,
  FakeBot,
  fakeQuestions,
  pressUpdate,
  textUpdate,
} from "../botquestions/testbot.ts";
import { ElicitationDesk, NO_ELICITATION_DESK } from "./elicitation_desk.ts";
import { DISK_FILES, Transcripts } from "./transcript.ts";
import { type CallerEnv, NO_WINDOWS } from "./window.ts";
import { sessionKeyOf, Sessions } from "./sessions.ts";
import { SESSION_ENV } from "@mpu/language/frames";
import { TestClock } from "./testclock.ts";

const OWNER = 111;

const testdata = (name: string) =>
  new URL(`testdata/elicitation/${name}`, import.meta.url);

async function live(
  name: string,
  over: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const payload = JSON.parse(await readFile(testdata(name), "utf8"));
  return JSON.stringify({ ...payload, ...over });
}

/** Что напечатал ответ хука. */
interface Told {
  readonly stdout: string;
  readonly stderr: string;
}

/** Стенд стола: бот и ответ хука на stdin. */
async function withDesk(
  body: (stand: {
    readonly bot: FakeBot;
    readonly ask: (
      stdin: string,
      signal?: AbortSignal,
      env?: CallerEnv,
    ) => Promise<Told>;
    readonly sessions: Sessions;
    /** Журнал службы. */
    readonly log: readonly string[];
  }) => Promise<void>,
): Promise<void> {
  const bot = new FakeBot();
  const questions = fakeQuestions(bot);
  const clock = new TestClock();
  const sessions = new Sessions(clock);
  const log: string[] = [];
  const desk = new ElicitationDesk({
    questions,
    transcripts: new Transcripts({ files: DISK_FILES, clock }),
    windows: NO_WINDOWS,
    sessions,
    clock,
    diagnose: (line) => void log.push(line),
  });
  questions.start();
  try {
    await body({
      bot,
      sessions,
      log,
      ask: async (
        stdin,
        signal = new AbortController().signal,
        env = () => undefined,
      ) => {
        let stdout = "";
        let stderr = "";
        const reply = await desk.reply(stdin, env, signal);
        reply.tell({
          stdout: (text) => void (stdout += text),
          stderr: (text) => void (stderr += text),
        });
        return { stdout, stderr };
      },
    });
  } finally {
    await questions.stop();
  }
}

/** Нажатие кнопки `label` в последнем показе вопроса. */
async function press(bot: FakeBot, label: string, update: number) {
  const shown = bot.calls.filter((call) => call.buttons.length > 0).at(-1);
  if (shown === undefined) throw new Error("кнопок нет");
  const row = shown.buttons.findIndex((buttons) => buttons.includes(label));
  if (row < 0) throw new Error(`нет кнопки ${label}: ${shown.buttons}`);
  const calls = bot.calls.length;
  bot.deliver([
    pressUpdate(
      update,
      OWNER,
      shown.data[row][shown.buttons[row].indexOf(label)],
    ),
  ]);
  await bot.called(calls + 1);
}

/** Текст владельца. */
async function write(bot: FakeBot, text: string, update: number) {
  const calls = bot.calls.length;
  bot.deliver([textUpdate(update, OWNER, text, 1)]);
  await bot.called(calls + 1);
}

/** Показ шага: заголовок, текст и кнопки. */
async function shownStep(bot: FakeBot, count: number) {
  await bot.called(count);
  const call = bot.calls[count - 1];
  return { text: call.text, buttons: call.buttons };
}

function decision(fields: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: "Elicitation", ...fields },
  })}\n`;
}

const UNDECIDED = "mpu claude-hook elicitation: без решения — ";

it("9: поля — шаг на поле; ответы — content, как его получает сервер", () =>
  withDesk(async ({ bot, ask }) => {
    const told = ask(await live("live-elicitation-fields.json"));
    expect(await shownStep(bot, 1)).toStrictEqual({
      text: "📝 elicitprobe 1/4 — ozon\nПРОБА-ФОРМА: применить?",
      buttons: [
        ["Разработка", "Прод"],
        ["Decline", "В терминале"],
      ],
    });
    await press(bot, "Разработка", 1);
    expect(await shownStep(bot, 3)).toStrictEqual({
      text: "📝 elicitprobe 2/4 — ozon\nПринудительно",
      buttons: [["Да", "Нет"], ["Пропустить", "Decline"], ["В терминале"]],
    });
    await press(bot, "Нет", 2);
    expect(await shownStep(bot, 5)).toStrictEqual({
      text: "📝 elicitprobe 3/4 — ozon\nЗаметка",
      buttons: [["Пропустить", "Decline"], ["В терминале"]],
    });
    await write(bot, "из хука", 3);
    expect((await shownStep(bot, 6)).text).toBe(
      "📝 elicitprobe 4/4 — ozon\nСколько",
    );
    await write(bot, "2", 4);
    const delivered = JSON.parse(
      await readFile(
        testdata("live-elicitation-accept-delivered.json"),
        "utf8",
      ),
    );
    // Решение хука — тот самый ответ, который сервер получил дословно.
    expect(await told).toStrictEqual({
      stdout: decision(delivered.result),
      stderr: "",
    });
    await bot.called(7);
    expect(bot.calls[6].text.split("\n").at(-1)).toBe(
      "✅ Разработка; Нет; из хука; 2 — из чата",
    );
  }));

it("10: не число — «нужно число», шаг остаётся", () =>
  withDesk(async ({ bot, ask }) => {
    const told = ask(await live("live-elicitation-fields.json"));
    await bot.called(1);
    await press(bot, "Прод", 1);
    await shownStep(bot, 3);
    await press(bot, "Пропустить", 2);
    await shownStep(bot, 5);
    await press(bot, "Пропустить", 3);
    await shownStep(bot, 7);
    await write(bot, "два", 4);
    expect(bot.calls[7].text).toBe("нужно число");
    await write(bot, "-3", 5);
    expect(await told).toStrictEqual({
      stdout: decision({
        action: "accept",
        content: { env: "prod", count: -3 },
      }),
      stderr: "",
    });
  }));

it("число number — дробное через запятую, обязательное поле без «Пропустить»", () =>
  withDesk(async ({ bot, ask }) => {
    const told = ask(
      await live("live-elicitation-fields.json", {
        requested_schema: {
          type: "object",
          properties: { ratio: { type: "number", title: "Доля" } },
          required: ["ratio"],
        },
      }),
    );
    expect(await shownStep(bot, 1)).toStrictEqual({
      text: "📝 elicitprobe — ozon\nПРОБА-ФОРМА: применить?",
      buttons: [["Decline", "В терминале"]],
    });
    await write(bot, "0,25", 1);
    expect(await told).toStrictEqual({
      stdout: decision({ action: "accept", content: { ratio: 0.25 } }),
      stderr: "",
    });
  }));

describe("9–11: форма без полей — Accept · Decline / В терминале", () => {
  for (const [label, stdout, line] of [
    [
      "Accept",
      decision({ action: "accept", content: {} }),
      "✅ Accept — из чата",
    ],
    ["Decline", decision({ action: "decline" }), "❌ Decline — из чата"],
  ] as const) {
    it(label, () =>
      withDesk(async ({ bot, ask }) => {
        const told = ask(
          await live("live-elicitation-mpu.json", {
            mcp_server_name: "gitlab",
            message: "Удалить ветку?",
          }),
        );
        expect(await shownStep(bot, 1)).toStrictEqual({
          text: "📝 gitlab — ozon\nУдалить ветку?",
          buttons: [["Accept", "Decline"], ["В терминале"]],
        });
        await press(bot, label, 1);
        expect(await told).toStrictEqual({ stdout, stderr: "" });
        await bot.called(3);
        expect(bot.calls[2].text.split("\n").at(-1)).toStrictEqual(line);
      }),
    );
  }
});

it("12: В терминале на любом шаге — без решения, «↪ ответ в терминале»", () =>
  withDesk(async ({ bot, ask }) => {
    const told = ask(await live("live-elicitation-fields.json"));
    await bot.called(1);
    await press(bot, "Разработка", 1);
    await shownStep(bot, 3);
    await press(bot, "В терминале", 2);
    expect(await told).toStrictEqual({
      stdout: "",
      stderr: `${UNDECIDED}ответ в терминале\n`,
    });
    await bot.called(5);
    expect(bot.calls[4].text.split("\n").at(-1)).toBe("↪ ответ в терминале");
    expect(bot.buttonedNow()).toBe(0);
  }));

it("Decline на первом шаге — отказ, следующие шаги не задаются", () =>
  withDesk(async ({ bot, ask }) => {
    const told = ask(await live("live-elicitation-fields.json"));
    await bot.called(1);
    await press(bot, "Decline", 1);
    expect(await told).toStrictEqual({
      stdout: decision({ action: "decline" }),
      stderr: "",
    });
    await bot.called(3);
    expect(
      bot.calls.filter((call) => call.text.includes("Принудительно")),
    ).toStrictEqual([]);
  }));

it("13: форма самого mpu — без вопроса", () =>
  withDesk(async ({ bot, ask }) => {
    expect(await ask(await live("live-elicitation-mpu.json"))).toStrictEqual({
      stdout: "",
      stderr: `${UNDECIDED}форма mpu — вопрос уже в чате\n`,
    });
    expect(bot.calls).toStrictEqual([]);
  }));

it("14: режим url — уведомление без кнопок, без решения", () =>
  withDesk(async ({ bot, ask }) => {
    const told = await ask(
      await live("live-elicitation-mpu.json", {
        mcp_server_name: "gitlab",
        message: "Войдите в GitLab",
        mode: "url",
        url: "https://gitlab.example/oauth",
      }),
    );
    expect(told).toStrictEqual({
      stdout: "",
      stderr: `${UNDECIDED}режим url — ответ по ссылке\n`,
    });
    expect(bot.calls).toStrictEqual([
      {
        method: "send",
        message: 0,
        text: "📝 gitlab\nВойдите в GitLab\nhttps://gitlab.example/oauth",
        buttons: [],
        data: [],
      },
    ]);
  }));

describe("поле объекта или полей больше четырёх — только Decline / В терминале", () => {
  const property = { type: "string" };
  for (const [name, properties] of [
    ["объект", { env: { type: "object" } }],
    [
      "пять полей",
      {
        a: property,
        b: property,
        c: property,
        d: property,
        e: property,
      },
    ],
  ] as const) {
    it(name, () =>
      withDesk(async ({ bot, ask }) => {
        const told = ask(
          await live("live-elicitation-fields.json", {
            requested_schema: { type: "object", properties },
          }),
        );
        expect(await shownStep(bot, 1)).toStrictEqual({
          text: "📝 elicitprobe — ozon\nПРОБА-ФОРМА: применить?",
          buttons: [["Decline", "В терминале"]],
        });
        await press(bot, "Decline", 1);
        expect((await told).stdout).toStrictEqual(
          decision({ action: "decline" }),
        );
      }),
    );
  }
});

describe("вход не разобран, бот не настроен, обрыв строки — без решения", () => {
  it("бот не настроен", async () => {
    const reply = await NO_ELICITATION_DESK.reply(
      await live("live-elicitation-fields.json"),
      () => undefined,
      new AbortController().signal,
    );
    let stderr = "";
    reply.tell({ stdout: () => {}, stderr: (text) => void (stderr += text) });
    expect(stderr).toStrictEqual(`${UNDECIDED}бот не настроен\n`);
  });
  it("не JSON-объект", () =>
    withDesk(async ({ ask }) => {
      expect((await ask("[]")).stderr).toStrictEqual(
        `${UNDECIDED}вход не разобран: stdin — не JSON-объект\n`,
      );
    }));
  it("нет mcp_server_name", () =>
    withDesk(async ({ ask }) => {
      expect((await ask('{"message":"?"}')).stderr).toStrictEqual(
        `${UNDECIDED}вход не разобран: нет mcp_server_name\n`,
      );
    }));
  it("нет message", () =>
    withDesk(async ({ ask }) => {
      expect((await ask('{"mcp_server_name":"gitlab"}')).stderr).toStrictEqual(
        `${UNDECIDED}вход не разобран: нет message\n`,
      );
    }));
  it("обрыв строки", () =>
    withDesk(async ({ bot, ask }) => {
      const gone = new AbortController();
      const told = ask(await live("live-elicitation-fields.json"), gone.signal);
      await bot.called(1);
      gone.abort();
      expect((await told).stderr).toStrictEqual(
        `${UNDECIDED}истёк срок ожидания\n`,
      );
    }));
});

it("R3c-6: форма в ряду — срочный вопрос сессии: снимка окна нет, решена — отпущена", () =>
  withDesk(async ({ bot, ask, sessions }) => {
    const env = (name: string) =>
      ({ [SESSION_ENV]: "/run/user/1000/cc-socks/k.sock" })[name];
    // Снимок, которому дали бы сесть, — вопрос без бота: исход у него
    // решён сразу, ряд он не трогает.
    const snapshot = () =>
      sessionKeyOf(env).seatSnapshot(sessions, () => NO_BOT.ask(f1()), {
        seated: () => "снимок",
        busy: () => "вопрос уже в чате",
      });
    const told = ask(
      await live("live-elicitation-mpu.json", {
        mcp_server_name: "gitlab",
        message: "Удалить ветку?",
      }),
      undefined,
      env,
    );
    await bot.called(1);
    expect(snapshot()).toBe("вопрос уже в чате");
    await press(bot, "Decline", 1);
    await told;
    expect(snapshot()).toBe("снимок");
  }));

it("14: уведомление url не ушло — без решения, причина в журнале службы", () =>
  withDesk(async ({ bot, ask, log }) => {
    bot.fail("send", new BotFailure("403 Forbidden", 403));
    const told = await ask(
      await live("live-elicitation-mpu.json", {
        mcp_server_name: "gitlab",
        message: "Войдите в GitLab",
        mode: "url",
      }),
    );
    expect(told.stderr).toStrictEqual(
      `${UNDECIDED}режим url — ответ по ссылке\n`,
    );
    expect(log).toStrictEqual([
      "claude-hook elicitation: бот недоступен: 403 Forbidden",
    ]);
  }));
