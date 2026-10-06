/**
 * Форма MCP-сервера целиком: payload → шаги в чате → решение
 * (`claude-hook-elicitation.md`; сценарии постановки R3 — номерами в
 * именах тестов). Бот — фейк, часы стола ведёт тест.
 */

import { assertEquals } from "@std/assert";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
  textUpdate,
} from "../botquestions/testbot.ts";
import { ElicitationDesk, NO_ELICITATION_DESK } from "./elicitation_desk.ts";
import { DISK_FILES, Transcripts } from "./transcript.ts";
import { NO_WINDOWS } from "./window.ts";
import { TestClock } from "./testclock.ts";

const OWNER = 111;

const testdata = (name: string) =>
  new URL(`testdata/elicitation/${name}`, import.meta.url);

async function live(
  name: string,
  over: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const payload = JSON.parse(await Deno.readTextFile(testdata(name)));
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
    readonly ask: (stdin: string, signal?: AbortSignal) => Promise<Told>;
  }) => Promise<void>,
): Promise<void> {
  const bot = new FakeBot();
  const questions = fakeQuestions(bot);
  const clock = new TestClock();
  const desk = new ElicitationDesk({
    questions,
    transcripts: new Transcripts({ files: DISK_FILES, clock }),
    windows: NO_WINDOWS,
    clock,
  });
  questions.start();
  try {
    await body({
      bot,
      ask: async (stdin, signal = new AbortController().signal) => {
        let stdout = "";
        let stderr = "";
        const reply = await desk.reply(stdin, () => undefined, signal);
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
  return `${
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "Elicitation", ...fields },
    })
  }\n`;
}

const UNDECIDED = "mpu claude-hook elicitation: без решения — ";

Deno.test("9: поля — шаг на поле; ответы — content, как его получает сервер", () =>
  withDesk(async ({ bot, ask }) => {
    const told = ask(await live("live-elicitation-fields.json"));
    assertEquals(await shownStep(bot, 1), {
      text: "📝 elicitprobe 1/4 — ozon\nПРОБА-ФОРМА: применить?",
      buttons: [["Разработка", "Прод"], ["Decline", "В терминале"]],
    });
    await press(bot, "Разработка", 1);
    assertEquals(await shownStep(bot, 3), {
      text: "📝 elicitprobe 2/4 — ozon\nПринудительно",
      buttons: [["Да", "Нет"], ["Пропустить", "Decline"], ["В терминале"]],
    });
    await press(bot, "Нет", 2);
    assertEquals(await shownStep(bot, 5), {
      text: "📝 elicitprobe 3/4 — ozon\nЗаметка",
      buttons: [["Пропустить", "Decline"], ["В терминале"]],
    });
    await write(bot, "из хука", 3);
    assertEquals(
      (await shownStep(bot, 6)).text,
      "📝 elicitprobe 4/4 — ozon\nСколько",
    );
    await write(bot, "2", 4);
    const delivered = JSON.parse(
      await Deno.readTextFile(
        testdata("live-elicitation-accept-delivered.json"),
      ),
    );
    // Решение хука — тот самый ответ, который сервер получил дословно.
    assertEquals(await told, {
      stdout: decision(delivered.result),
      stderr: "",
    });
    await bot.called(7);
    assertEquals(
      bot.calls[6].text.split("\n").at(-1),
      "✅ Разработка; Нет; из хука; 2 — из чата",
    );
  }));

Deno.test("10: не число — «нужно число», шаг остаётся", () =>
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
    assertEquals(bot.calls[7].text, "нужно число");
    await write(bot, "-3", 5);
    assertEquals(await told, {
      stdout: decision({
        action: "accept",
        content: { env: "prod", count: -3 },
      }),
      stderr: "",
    });
  }));

Deno.test("число number — дробное через запятую, обязательное поле без «Пропустить»", () =>
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
    assertEquals(await shownStep(bot, 1), {
      text: "📝 elicitprobe — ozon\nПРОБА-ФОРМА: применить?",
      buttons: [["Decline", "В терминале"]],
    });
    await write(bot, "0,25", 1);
    assertEquals(await told, {
      stdout: decision({ action: "accept", content: { ratio: 0.25 } }),
      stderr: "",
    });
  }));

Deno.test("9–11: форма без полей — Accept · Decline / В терминале", async (t) => {
  for (
    const [label, stdout, line] of [
      [
        "Accept",
        decision({ action: "accept", content: {} }),
        "✅ Accept — из чата",
      ],
      ["Decline", decision({ action: "decline" }), "❌ Decline — из чата"],
    ] as const
  ) {
    await t.step(label, () =>
      withDesk(async ({ bot, ask }) => {
        const told = ask(
          await live("live-elicitation-mpu.json", {
            mcp_server_name: "gitlab",
            message: "Удалить ветку?",
          }),
        );
        assertEquals(await shownStep(bot, 1), {
          text: "📝 gitlab — ozon\nУдалить ветку?",
          buttons: [["Accept", "Decline"], ["В терминале"]],
        });
        await press(bot, label, 1);
        assertEquals(await told, { stdout, stderr: "" });
        await bot.called(3);
        assertEquals(bot.calls[2].text.split("\n").at(-1), line);
      }));
  }
});

Deno.test("12: В терминале на любом шаге — без решения, «↪ ответ в терминале»", () =>
  withDesk(async ({ bot, ask }) => {
    const told = ask(await live("live-elicitation-fields.json"));
    await bot.called(1);
    await press(bot, "Разработка", 1);
    await shownStep(bot, 3);
    await press(bot, "В терминале", 2);
    assertEquals(await told, {
      stdout: "",
      stderr: `${UNDECIDED}ответ в терминале\n`,
    });
    await bot.called(5);
    assertEquals(bot.calls[4].text.split("\n").at(-1), "↪ ответ в терминале");
    assertEquals(bot.buttonedNow(), 0);
  }));

Deno.test("Decline на первом шаге — отказ, следующие шаги не задаются", () =>
  withDesk(async ({ bot, ask }) => {
    const told = ask(await live("live-elicitation-fields.json"));
    await bot.called(1);
    await press(bot, "Decline", 1);
    assertEquals(await told, {
      stdout: decision({ action: "decline" }),
      stderr: "",
    });
    await bot.called(3);
    assertEquals(
      bot.calls.filter((call) => call.text.includes("Принудительно")),
      [],
    );
  }));

Deno.test("13: форма самого mpu — без вопроса", () =>
  withDesk(async ({ bot, ask }) => {
    assertEquals(await ask(await live("live-elicitation-mpu.json")), {
      stdout: "",
      stderr: `${UNDECIDED}форма mpu — вопрос уже в чате\n`,
    });
    assertEquals(bot.calls, []);
  }));

Deno.test("14: режим url — уведомление без кнопок, без решения", () =>
  withDesk(async ({ bot, ask }) => {
    const told = await ask(
      await live("live-elicitation-mpu.json", {
        mcp_server_name: "gitlab",
        message: "Войдите в GitLab",
        mode: "url",
        url: "https://gitlab.example/oauth",
      }),
    );
    assertEquals(told, {
      stdout: "",
      stderr: `${UNDECIDED}режим url — ответ по ссылке\n`,
    });
    assertEquals(bot.calls, [{
      method: "send",
      message: 0,
      text: "📝 gitlab\nВойдите в GitLab\nhttps://gitlab.example/oauth",
      buttons: [],
      data: [],
    }]);
  }));

Deno.test("поле объекта или полей больше четырёх — только Decline / В терминале", async (t) => {
  const property = { type: "string" };
  for (
    const [name, properties] of [
      ["объект", { env: { type: "object" } }],
      ["пять полей", {
        a: property,
        b: property,
        c: property,
        d: property,
        e: property,
      }],
    ] as const
  ) {
    await t.step(name, () =>
      withDesk(async ({ bot, ask }) => {
        const told = ask(
          await live("live-elicitation-fields.json", {
            requested_schema: { type: "object", properties },
          }),
        );
        assertEquals(await shownStep(bot, 1), {
          text: "📝 elicitprobe — ozon\nПРОБА-ФОРМА: применить?",
          buttons: [["Decline", "В терминале"]],
        });
        await press(bot, "Decline", 1);
        assertEquals((await told).stdout, decision({ action: "decline" }));
      }));
  }
});

Deno.test("вход не разобран, бот не настроен, обрыв строки — без решения", async (t) => {
  await t.step("бот не настроен", async () => {
    const reply = await NO_ELICITATION_DESK.reply(
      await live("live-elicitation-fields.json"),
      () => undefined,
      new AbortController().signal,
    );
    let stderr = "";
    reply.tell({ stdout: () => {}, stderr: (text) => void (stderr += text) });
    assertEquals(stderr, `${UNDECIDED}бот не настроен\n`);
  });
  await t.step("не JSON-объект", () =>
    withDesk(async ({ ask }) => {
      assertEquals(
        (await ask("[]")).stderr,
        `${UNDECIDED}вход не разобран: stdin — не JSON-объект\n`,
      );
    }));
  await t.step("нет mcp_server_name", () =>
    withDesk(async ({ ask }) => {
      assertEquals(
        (await ask('{"message":"?"}')).stderr,
        `${UNDECIDED}вход не разобран: нет mcp_server_name\n`,
      );
    }));
  await t.step("нет message", () =>
    withDesk(async ({ ask }) => {
      assertEquals(
        (await ask('{"mcp_server_name":"gitlab"}')).stderr,
        `${UNDECIDED}вход не разобран: нет message\n`,
      );
    }));
  await t.step("обрыв строки", () =>
    withDesk(async ({ bot, ask }) => {
      const gone = new AbortController();
      const told = ask(await live("live-elicitation-fields.json"), gone.signal);
      await bot.called(1);
      gone.abort();
      assertEquals((await told).stderr, `${UNDECIDED}истёк срок ожидания\n`);
    }));
});
