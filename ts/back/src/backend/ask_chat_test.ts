/**
 * Подтверждение строки и в Telegram (`platform/ask-telegram.md`,
 * сценарии постановки R3 [S1–S8]): вопрос `[y/N]` уходит каналу строки и
 * владельцу в чат одновременно, решает первый ответ.
 */

import { assert, assertEquals } from "@std/assert";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
} from "../botquestions/testbot.ts";
import { Windows } from "../claudehook/mod.ts";
import type { CommandIo } from "../command/mod.ts";
import { ALLOW, ASK, RuleBook, RulePath } from "../policy/mod.ts";
import {
  Client,
  collected,
  type Frame,
  post,
  type TestBack,
  withBack,
  within,
} from "./testback.ts";

const OWNER = 111;

const QUESTION = "выполнить mpu xlsx alias ls? [y/N] ";

/** Окно клиента под tmux — как его подписывает `tmux display-message`. */
const TMUX_ENV = { TMUX: "/tmp/tmux-1000/default,4242,0", TMUX_PANE: "%3" };

const WINDOWS = new Windows(() => Promise.resolve("w:2 claude\n"));

function asking(back: TestBack) {
  using book = RuleBook.open(back.policyFile, []);
  book.set(RulePath.parse("xlsx alias ls"), ASK);
}

/** Строка `ask xlsx alias ls` по сокету клиента с человеком под tmux. */
async function terminalLine(
  back: TestBack,
  words: readonly string[] = ["ask", "xlsx", "alias", "ls"],
  extra: Readonly<Record<string, unknown>> = {},
): Promise<Client> {
  asking(back);
  const client = new Client(back, "/line");
  await client.opened();
  client.send({ words, cwd: Deno.cwd(), human: true, env: TMUX_ENV, ...extra });
  return client;
}

/** Нажатие кнопки `label` первого сообщения владельцем. */
function press(bot: FakeBot, label: string, update = 1) {
  const sent = bot.calls[0];
  const row = sent.buttons.findIndex((buttons) => buttons.includes(label));
  const data = sent.data[row][sent.buttons[row].indexOf(label)];
  bot.deliver([pressUpdate(update, OWNER, data)]);
}

/** Последняя правка сообщения вопроса. */
async function lastLine(bot: FakeBot, count: number): Promise<string> {
  await within(bot.called(count), 5000, `вызов ${count}`);
  const edits = bot.calls.filter((call) => call.method === "edit");
  return edits.at(-1)?.text.split("\n").at(-1) ?? "";
}

Deno.test("S1–S2: вопрос и в чат; «Да» в чате — кадр settled, строка исполнена", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const client = await terminalLine(back);
    await within(bot.called(1), 5000, "вопрос в чате");
    assertEquals(
      bot.calls[0].text,
      "❓ mpu ask — w:2 claude\nвыполнить mpu xlsx alias ls?",
    );
    assertEquals(bot.calls[0].buttons, [["Да", "Нет"]]);
    await client.frame((frame) => "ask" in frame);
    press(bot, "Да");
    const frames = await client.finished();
    assertEquals(
      frames.filter((frame) => "ask" in frame || "settled" in frame),
      [
        { ask: QUESTION },
        { settled: "решено в Telegram — да" },
      ],
    );
    assertEquals(frames.at(-1), { exit: 0 });
    assertEquals(back.called, ["xlsx alias ls"]);
    assertEquals(await lastLine(bot, 3), "✅ Да — из чата");
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("S3: «Нет» в чате — отказ, как на n", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const client = await terminalLine(back);
    await within(bot.called(1), 5000, "вопрос в чате");
    press(bot, "Нет");
    const frames = await client.finished();
    assert(
      frames.some((frame) => frame.settled === "решено в Telegram — нет"),
      JSON.stringify(frames),
    );
    assertEquals(frames.at(-1), { exit: 1 });
    assertEquals(back.called, []);
    assertEquals(await lastLine(bot, 3), "❌ Нет — из чата");
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("S4: ответ в терминале первым — «решено в терминале», нажатие после — уже решён", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const client = await terminalLine(back);
    await within(bot.called(1), 5000, "вопрос в чате");
    await client.frame((frame) => "ask" in frame);
    client.answer("y");
    const frames = await client.finished();
    assertEquals(frames.some((frame) => "settled" in frame), false);
    assertEquals(frames.at(-1), { exit: 0 });
    assertEquals(await lastLine(bot, 2), "✅ решено в терминале");
    press(bot, "Да");
    await within(bot.called(3), 5000, "подтверждение нажатия");
    assertEquals(bot.calls[2], {
      method: "ack",
      message: 0,
      text: "вопрос уже решён",
      buttons: [],
      data: [],
    });
    assertEquals(back.called, ["xlsx alias ls"]);
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("строка оборвалась — сообщение «истёк»", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const client = await terminalLine(back);
    await within(bot.called(1), 5000, "вопрос в чате");
    client.close();
    assertEquals(await lastLine(bot, 2), "⌛ истёк — ответьте в терминале");
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

/** Строка `ask xlsx alias ls` двери агента простым HTTP: вопрос с номером. */
async function agentQuestion(back: TestBack): Promise<Frame> {
  asking(back);
  return await collected(
    back,
    await post(back, "/agent/line", {
      words: ["ask", "xlsx", "alias", "ls"],
      cwd: Deno.cwd(),
      human: true,
    }, { accept: "application/json" }),
  );
}

/** Ответ по номеру двери агента собранным JSON. */
async function agentAnswer(back: TestBack, ticket: unknown, answer: string) {
  return await collected(
    back,
    await post(back, "/agent/line/answer", { ticket, answer }, {
      accept: "application/json",
    }),
  );
}

Deno.test("S5: дверь агента номером — «(MCP)»; settled — сразу текст решения, продолжение — ответом по номеру", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const first = await agentQuestion(back);
    assertEquals(first.ask, QUESTION);
    await within(bot.called(1), 5000, "вопрос в чате");
    assertEquals(
      bot.calls[0].text,
      "❓ mpu ask (MCP)\nвыполнить mpu xlsx alias ls?",
    );
    const waiting = post(back, "/agent/line/settled", { ticket: first.ticket });
    press(bot, "Да");
    const settled = await waiting;
    assertEquals(await settled.json(), { settled: "решено в Telegram — да" });
    // Строка ждёт, пока продолжение не заберут, — и исполняется с
    // решённым ответом: присланный «нет» — второй ответ.
    assertEquals(back.called, []);
    assertEquals((await agentAnswer(back, first.ticket, "n")).exit, 0);
    assertEquals(back.called, ["xlsx alias ls"]);
    assertEquals(await lastLine(bot, 3), "✅ Да — из чата");
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("S5: ожидание settled оборвано клиентом — строка цела, решение забирается ответом", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const first = await agentQuestion(back);
    await within(bot.called(1), 5000, "вопрос в чате");
    const left = new AbortController();
    const waiting = post(
      back,
      "/agent/line/settled",
      { ticket: first.ticket },
      {
        signal: left.signal,
      },
    );
    left.abort();
    await waiting.then((response) => response.body?.cancel(), () => {});
    press(bot, "Да");
    assertEquals(await lastLine(bot, 3), "✅ Да — из чата");
    // Решение помнится и для запроса, пришедшего после него.
    const late = await post(back, "/agent/line/settled", {
      ticket: first.ticket,
    });
    assertEquals(await late.json(), { settled: "решено в Telegram — да" });
    assertEquals((await agentAnswer(back, first.ticket, "")).exit, 0);
    assertEquals(back.called, ["xlsx alias ls"]);
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("S5: два ожидания settled одного номера — оба получают решение", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const first = await agentQuestion(back);
    await within(bot.called(1), 5000, "вопрос в чате");
    const one = post(back, "/agent/line/settled", { ticket: first.ticket });
    const two = post(back, "/agent/line/settled", { ticket: first.ticket });
    press(bot, "Нет");
    for (const response of await Promise.all([one, two])) {
      assertEquals(await response.json(), {
        settled: "решено в Telegram — нет",
      });
    }
    assertEquals((await agentAnswer(back, first.ticket, "y")).exit, 1);
    assertEquals(back.called, []);
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("страница и curl (номер двери человека) — в чат ничего: снять их вопрос нечем", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    asking(back);
    const first = await collected(
      back,
      await post(back, "/line", {
        words: ["ask", "xlsx", "alias", "ls"],
        cwd: Deno.cwd(),
        human: true,
      }, { accept: "application/json" }),
    );
    assertEquals(first.ask, QUESTION);
    const done = await collected(
      back,
      await post(back, "/line/answer", { ticket: first.ticket, answer: "y" }, {
        accept: "application/json",
      }),
    );
    assertEquals(done.exit, 0);
    assertEquals(bot.calls, []);
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("S5: ответ формы первым — ожидание settled получает 404", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const first = await agentQuestion(back);
    await within(bot.called(1), 5000, "вопрос в чате");
    const waiting = post(
      back,
      "/agent/line/settled",
      { ticket: first.ticket },
      {
        accept: "application/json",
      },
    );
    const answered = await collected(
      back,
      await post(back, "/agent/line/answer", {
        ticket: first.ticket,
        answer: "y",
      }, { accept: "application/json" }),
    );
    assertEquals(answered.exit, 0);
    const gone = await waiting;
    assertEquals(gone.status, 404);
    back.seen.push(await gone.text());
    assertEquals(await lastLine(bot, 2), "✅ решено в терминале");
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("S5: решено в чате раньше запроса settled — ответ формы получает решённое", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const first = await agentQuestion(back);
    await within(bot.called(1), 5000, "вопрос в чате");
    press(bot, "Да");
    assertEquals(await lastLine(bot, 3), "✅ Да — из чата");
    assertEquals((await agentAnswer(back, first.ticket, "n")).exit, 0);
    assertEquals(back.called, ["xlsx alias ls"]);
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("S7: бот не настроен — вопрос только каналу строки", () =>
  withBack(async (back) => {
    const client = await terminalLine(back);
    await client.frame((frame) => "ask" in frame);
    client.answer("y");
    const frames = await client.finished();
    assertEquals(frames.at(-1), { exit: 0 });
  }, { windows: WINDOWS }));

Deno.test("S8: mpu confirm — так же: вопрос в чат, «Да» отпускает конвейер", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const client = await terminalLine(back, ["confirm"], {
      stdin: "данные конвейера\n",
    });
    await within(bot.called(1), 5000, "вопрос в чате");
    assertEquals(bot.calls[0].text, "❓ mpu ask — w:2 claude\nПрименить?");
    press(bot, "Да");
    const frames = await client.finished();
    assertEquals(frames.filter((frame) => "out" in frame), [
      { out: "данные конвейера\n" },
    ]);
    assertEquals(frames.at(-1), { exit: 0 });
  }, { questions: fakeQuestions(bot), windows: WINDOWS });
});

Deno.test("вопрос не [y/N] и строка без человека — в чат ничего", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    // `telegram login` спрашивает «Set up Telegram now? [y/N]: » — не
    // подтверждение строки: хвост другой (`platform/ask-telegram.md`, S6).
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("telegram login"), ALLOW);
    }
    const login = await terminalLine(back, ["telegram", "login"]);
    await login.frame((frame) => frame.ask === "Set up Telegram now? [y/N]: ");
    login.answer("n");
    await login.finished();
    const nobody = await terminalLine(back, ["ask", "xlsx", "alias", "ls"], {
      human: false,
    });
    await nobody.finished();
    assertEquals(bot.calls, []);
  }, { questions: fakeQuestions(bot), windows: WINDOWS, io: emptyEnvFile() });
});

/** Пустой env-файл: `telegram login` пишет ключи в него, а не на диск. */
function emptyEnvFile(): Partial<CommandIo> {
  const values: Record<string, string> = {};
  return {
    envFile: {
      get: (name: string) => values[name],
      values: () => ({ ...values }),
      require: (name: string) => values[name] ?? "",
      set: (name: string, value: string) => {
        values[name] = value;
        return Promise.resolve();
      },
    },
  };
}
