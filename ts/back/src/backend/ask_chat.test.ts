/**
 * Подтверждение строки и в Telegram (`platform/ask-telegram.md`,
 * сценарии постановки R3 [S1–S8]): вопрос `[y/N]` уходит каналу строки и
 * владельцу в чат одновременно, решает первый ответ.
 */

import { assert, expect, it } from "vitest";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
} from "@mpu/cmd-botquestions/testing";
import { Windows } from "@mpu/cmd-claudehook";
import type { CommandIo } from "@mpu/command";
import { ALLOW, ASK, RuleBook, RulePath } from "@mpu/command/policy";
import { violations } from "./testschema.ts";
import SCHEMA from "./schema.json" with { type: "json" };
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
  client.send({
    words,
    cwd: process.cwd(),
    human: true,
    env: TMUX_ENV,
    ...extra,
  });
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

it("S1–S2: вопрос и в чат; «Да» в чате — кадр settled, строка исполнена", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const client = await terminalLine(back);
      await within(bot.called(1), 5000, "вопрос в чате");
      expect(bot.calls[0].text).toBe(
        "❓ mpu ask — w:2 claude\nвыполнить mpu xlsx alias ls?",
      );
      expect(bot.calls[0].buttons).toStrictEqual([["Да", "Нет"]]);
      await client.frame((frame) => "ask" in frame);
      press(bot, "Да");
      const frames = await client.finished();
      expect(
        frames.filter((frame) => "ask" in frame || "settled" in frame),
      ).toStrictEqual([
        { ask: QUESTION },
        { settled: "решено в Telegram — да" },
      ]);
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
      // Каждый кадр, кадр settled тоже, — по схеме контракта кадров.
      for (const frame of frames) {
        expect(
          violations(SCHEMA, SCHEMA.$defs["line.server"], frame),
          JSON.stringify(frame),
        ).toStrictEqual([]);
      }
      expect(back.called).toStrictEqual(["xlsx alias ls"]);
      expect(await lastLine(bot, 3)).toBe("✅ Да — из чата");
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("S3: «Нет» в чате — отказ, как на n", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const client = await terminalLine(back);
      await within(bot.called(1), 5000, "вопрос в чате");
      press(bot, "Нет");
      const frames = await client.finished();
      assert(
        frames.some((frame) => frame.settled === "решено в Telegram — нет"),
        JSON.stringify(frames),
      );
      expect(frames.at(-1)).toStrictEqual({ exit: 1 });
      expect(back.called).toStrictEqual([]);
      expect(await lastLine(bot, 3)).toBe("❌ Нет — из чата");
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("S4: ответ в терминале первым — «решено в терминале», нажатие после — уже решён", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const client = await terminalLine(back);
      await within(bot.called(1), 5000, "вопрос в чате");
      await client.frame((frame) => "ask" in frame);
      client.answer("y");
      const frames = await client.finished();
      expect(frames.some((frame) => "settled" in frame)).toBe(false);
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
      expect(await lastLine(bot, 2)).toBe("✅ решено в терминале");
      press(bot, "Да");
      await within(bot.called(3), 5000, "подтверждение нажатия");
      expect(bot.calls[2]).toStrictEqual({
        method: "ack",
        message: 0,
        text: "вопрос уже решён",
        buttons: [],
        data: [],
      });
      expect(back.called).toStrictEqual(["xlsx alias ls"]);
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("строка оборвалась — сообщение «истёк»", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const client = await terminalLine(back);
      await within(bot.called(1), 5000, "вопрос в чате");
      client.close();
      expect(await lastLine(bot, 2)).toBe("⌛ истёк — ответьте в терминале");
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

/** Строка `ask xlsx alias ls` двери агента простым HTTP: вопрос с номером. */
async function agentQuestion(back: TestBack): Promise<Frame> {
  asking(back);
  return await collected(
    back,
    await post(
      back,
      "/agent/line",
      {
        words: ["ask", "xlsx", "alias", "ls"],
        cwd: process.cwd(),
        human: true,
      },
      { accept: "application/json" },
    ),
  );
}

/** Ответ по номеру двери агента собранным JSON. */
async function agentAnswer(back: TestBack, ticket: unknown, answer: string) {
  return await collected(
    back,
    await post(
      back,
      "/agent/line/answer",
      { ticket, answer },
      {
        accept: "application/json",
      },
    ),
  );
}

it("S5: дверь агента номером — «(MCP)»; settled — сразу текст решения, продолжение — ответом по номеру", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const first = await agentQuestion(back);
      expect(first.ask).toStrictEqual(QUESTION);
      await within(bot.called(1), 5000, "вопрос в чате");
      expect(bot.calls[0].text).toBe(
        "❓ mpu ask (MCP)\nвыполнить mpu xlsx alias ls?",
      );
      const body = { ticket: first.ticket };
      expect(
        violations(SCHEMA, SCHEMA.$defs["http.line.settled.request"], body),
      ).toStrictEqual([]);
      const waiting = post(back, "/agent/line/settled", body);
      press(bot, "Да");
      const settled = await (await waiting).json();
      expect(settled).toStrictEqual({ settled: "решено в Telegram — да" });
      expect(
        violations(SCHEMA, SCHEMA.$defs["http.line.settled"], settled),
      ).toStrictEqual([]);
      // Строка ждёт, пока продолжение не заберут, — и исполняется с
      // решённым ответом: присланный «нет» — второй ответ.
      expect(back.called).toStrictEqual([]);
      expect((await agentAnswer(back, first.ticket, "n")).exit).toBe(0);
      expect(back.called).toStrictEqual(["xlsx alias ls"]);
      expect(await lastLine(bot, 3)).toBe("✅ Да — из чата");
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("S5: ожидание settled оборвано клиентом — строка цела, решение забирается ответом", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
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
      await waiting.then(
        (response) => response.body?.cancel(),
        () => {},
      );
      press(bot, "Да");
      expect(await lastLine(bot, 3)).toBe("✅ Да — из чата");
      // Решение помнится и для запроса, пришедшего после него.
      const late = await post(back, "/agent/line/settled", {
        ticket: first.ticket,
      });
      expect(await late.json()).toStrictEqual({
        settled: "решено в Telegram — да",
      });
      expect((await agentAnswer(back, first.ticket, "")).exit).toBe(0);
      expect(back.called).toStrictEqual(["xlsx alias ls"]);
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("S5: два ожидания settled одного номера — оба получают решение", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const first = await agentQuestion(back);
      await within(bot.called(1), 5000, "вопрос в чате");
      const one = post(back, "/agent/line/settled", { ticket: first.ticket });
      const two = post(back, "/agent/line/settled", { ticket: first.ticket });
      press(bot, "Нет");
      for (const response of await Promise.all([one, two])) {
        expect(await response.json()).toStrictEqual({
          settled: "решено в Telegram — нет",
        });
      }
      expect((await agentAnswer(back, first.ticket, "y")).exit).toBe(1);
      expect(back.called).toStrictEqual([]);
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("страница и curl (номер двери человека) — в чат ничего: снять их вопрос нечем", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      asking(back);
      const first = await collected(
        back,
        await post(
          back,
          "/line",
          {
            words: ["ask", "xlsx", "alias", "ls"],
            cwd: process.cwd(),
            human: true,
          },
          { accept: "application/json" },
        ),
      );
      expect(first.ask).toStrictEqual(QUESTION);
      const done = await collected(
        back,
        await post(
          back,
          "/line/answer",
          { ticket: first.ticket, answer: "y" },
          {
            accept: "application/json",
          },
        ),
      );
      expect(done.exit).toBe(0);
      expect(bot.calls).toStrictEqual([]);
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("S5: ответ формы первым — ожидание settled получает 404", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
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
        await post(
          back,
          "/agent/line/answer",
          {
            ticket: first.ticket,
            answer: "y",
          },
          { accept: "application/json" },
        ),
      );
      expect(answered.exit).toBe(0);
      const gone = await waiting;
      expect(gone.status).toBe(404);
      back.seen.push(await gone.text());
      expect(await lastLine(bot, 2)).toBe("✅ решено в терминале");
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("S5: решено в чате раньше запроса settled — ответ формы получает решённое", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const first = await agentQuestion(back);
      await within(bot.called(1), 5000, "вопрос в чате");
      press(bot, "Да");
      expect(await lastLine(bot, 3)).toBe("✅ Да — из чата");
      expect((await agentAnswer(back, first.ticket, "n")).exit).toBe(0);
      expect(back.called).toStrictEqual(["xlsx alias ls"]);
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("S7: бот не настроен — вопрос только каналу строки", () =>
  withBack(
    async (back) => {
      const client = await terminalLine(back);
      await client.frame((frame) => "ask" in frame);
      client.answer("y");
      const frames = await client.finished();
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
    },
    { windows: WINDOWS },
  ));

it("S8: mpu confirm — так же: вопрос в чат, «Да» отпускает конвейер", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const client = await terminalLine(back, ["confirm"], {
        stdin: "данные конвейера\n",
      });
      await within(bot.called(1), 5000, "вопрос в чате");
      expect(bot.calls[0].text).toBe("❓ mpu ask — w:2 claude\nПрименить?");
      press(bot, "Да");
      const frames = await client.finished();
      expect(frames.filter((frame) => "out" in frame)).toStrictEqual([
        { out: "данные конвейера\n" },
      ]);
      expect(frames.at(-1)).toStrictEqual({ exit: 0 });
    },
    { questions: fakeQuestions(bot), windows: WINDOWS },
  );
});

it("вопрос не [y/N] и строка без человека — в чат ничего", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      // `telegram login` спрашивает «Set up Telegram now? [y/N]: » — не
      // подтверждение строки: хвост другой (`platform/ask-telegram.md`, S6).
      {
        using book = RuleBook.open(back.policyFile, []);
        book.set(RulePath.parse("telegram login"), ALLOW);
      }
      const login = await terminalLine(back, ["telegram", "login"]);
      await login.frame(
        (frame) => frame.ask === "Set up Telegram now? [y/N]: ",
      );
      login.answer("n");
      await login.finished();
      const nobody = await terminalLine(back, ["ask", "xlsx", "alias", "ls"], {
        human: false,
      });
      await nobody.finished();
      expect(bot.calls).toStrictEqual([]);
    },
    { questions: fakeQuestions(bot), windows: WINDOWS, io: emptyEnvFile() },
  );
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
