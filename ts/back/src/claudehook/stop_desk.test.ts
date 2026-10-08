/**
 * Вопрос «ждёт ввода» хука `Stop` целиком: payload → сообщение в чате →
 * хук вышел; снятие транскриптом, новым концом хода, остановкой ядра
 * (`claude-hook-stop.md`; сценарии постановки R2a — номерами в именах
 * тестов). Бот — фейк, транскрипт — файл во временном каталоге, часы
 * наблюдателя ведёт тест.
 */

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it } from "vitest";
import { type Asked, NO_BOT } from "@mpu/cmd-botquestions";
import { BotFailure } from "@mpu/cmd-botquestions/testing";
import {
  f1,
  FakeBot,
  fakeQuestions,
  pressUpdate,
  textUpdate,
} from "@mpu/cmd-botquestions/testing";
import { Sessions } from "./sessions.ts";
import { StopDesk } from "./stop_desk.ts";
import { TestClock } from "./testclock.ts";
import { DISK_FILES, Transcripts, WATCH_MS } from "./transcript.ts";
import { NO_WINDOWS, type TmuxRun, Windows } from "./window.ts";

const testdata = (name: string) =>
  new URL(`testdata/stop/${name}`, import.meta.url);

/** Что напечатал ответ хука. */
interface Told {
  readonly stdout: string;
  readonly stderr: string;
}

const SILENT: Told = { stdout: "", stderr: "" };

const NO_QUESTION = "mpu claude-hook stop: без вопроса — ";

/** Транскрипт сессии A: название `mpu-bot`, прошлый ход. */
const TITLED = [
  '{"type":"custom-title","customTitle":"mpu-bot"}',
  '{"type":"user","message":{"role":"user","content":"Выбери день"}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Вы выбрали: Пн."}]}}',
];

/** tmux сессии A: окно `w:2 claude`. */
const TMUX_A: TmuxRun = (args) =>
  Promise.resolve(args.includes("%7") ? "w:2 claude\n" : undefined);

const SOCKET_A = "/run/user/1000/cc-socks/4242.sock";

const ENV_A = {
  TMUX: "/tmp/tmux-1000/default,4242,0",
  TMUX_PANE: "%7",
  CLAUDE_CODE_MESSAGING_SOCKET: SOCKET_A,
};

const HEAD_A = "💬 mpu-bot — ozon · w:2 claude";
const NO_CHANNEL_LINE = "ответ — в терминале (сессия без канала)";

/** Стенд стола: бот, транскрипт, окно, часы. */
async function withStopDesk(
  body: (stand: {
    readonly bot: FakeBot;
    readonly clock: TestClock;
    readonly log: readonly string[];
    readonly urgent: () => Asked;
    readonly append: (line: string) => Promise<void>;
    readonly payload: (over?: Readonly<Record<string, unknown>>) => string;
    readonly stop: (
      stdin: string,
      env?: Readonly<Record<string, string>>,
    ) => Promise<Told>;
    readonly desk: StopDesk;
  }) => Promise<void>,
  options: { readonly lines?: readonly string[] } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const transcript = `${dir}/session.jsonl`;
  await writeFile(
    transcript,
    (options.lines ?? TITLED).map((line) => `${line}\n`).join(""),
  );
  const live = JSON.parse(await readFile(testdata("live-stop.json"), "utf8"));
  const bot = new FakeBot();
  const log: string[] = [];
  const questions = fakeQuestions(bot);
  const clock = new TestClock();
  const desk = new StopDesk({
    questions,
    transcripts: new Transcripts({ files: DISK_FILES, clock }),
    windows: new Windows(TMUX_A),
    sessions: new Sessions(clock),
    diagnose: (line) => log.push(line),
  });
  const stop = async (
    stdin: string,
    env: Readonly<Record<string, string>> = ENV_A,
  ) => {
    let stdout = "";
    let stderr = "";
    const reply = await desk.reply(stdin, (name) => env[name]);
    reply.tell({
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
    });
    return { stdout, stderr };
  };
  questions.start();
  try {
    await body({
      bot,
      clock,
      log,
      urgent: () => questions.ask(f1()),
      append: (line) => appendFile(transcript, `${line}\n`),
      payload: (over = {}) =>
        JSON.stringify({ ...live, transcript_path: transcript, ...over }),
      stop,
      desk,
    });
  } finally {
    await desk.stop();
    await questions.stop();
    await rm(dir, { recursive: true });
  }
}

/**
 * Оборот наблюдателя после дописанного: вопрос не снят — наблюдатель
 * встал на следующую паузу раньше, чем пришла правка сообщения.
 */
async function turn(clock: TestClock, bot: FakeBot, calls: number) {
  clock.fire(WATCH_MS);
  const first = await Promise.race([
    bot.called(calls + 1).then(() => "снят"),
    clock.paused(WATCH_MS).then(() => "ждёт"),
  ]);
  expect(first, "вопрос снят записью, которая не набранный ввод").toBe("ждёт");
}

/**
 * Оборот после записи набранного ввода: вопрос обязан сняться за него. Не
 * снялся — наблюдатель встаёт на следующую паузу, и тест краснеет, а не
 * висит.
 */
async function withdrawnBy(clock: TestClock, bot: FakeBot, calls: number) {
  clock.fire(WATCH_MS);
  const first = await Promise.race([
    bot.called(calls + 1).then(() => "снят"),
    clock.paused(WATCH_MS).then(() => "ждёт"),
  ]);
  expect(first, "набранный ввод не снял вопрос за один оборот").toBe("снят");
}

it("R2a-1: конец хода — сообщение «ждёт ввода», хук вышел до ответа: stdout пуст", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    const told = await stop(payload());
    expect(told).toStrictEqual(SILENT);
    // Хук вышел, а в чате — ровно показ, ни одного апдейта не было.
    expect(bot.calls).toStrictEqual([
      {
        method: "send",
        message: 0,
        text: `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}`,
        buttons: [["Пропустить"]],
        data: [["r1:1:0:skip"]],
      },
    ]);
  });
});

it("R2a-2: продолжение хода (stop_hook_active) — в чат ничего", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    expect(await stop(payload({ stop_hook_active: true }))).toStrictEqual({
      stdout: "",
      stderr: `${NO_QUESTION}продолжение хода\n`,
    });
    expect(bot.calls).toStrictEqual([]);
  });
});

describe("вход не разобран — причина; в чат ничего", () => {
  for (const [name, stdin, what] of [
    ["не JSON", "{", "stdin — не JSON-объект"],
    ["массив", "[]", "stdin — не JSON-объект"],
    [
      "нет last_assistant_message",
      '{"hook_event_name":"Stop"}',
      "нет last_assistant_message",
    ],
  ] as const) {
    it(name, () =>
      withStopDesk(async ({ bot, stop }) => {
        expect(await stop(stdin)).toStrictEqual({
          stdout: "",
          stderr: `${NO_QUESTION}вход не разобран: ${what}\n`,
        });
        expect(bot.calls).toStrictEqual([]);
      }),
    );
  }
});

it("R2a-3: сообщение в 9000 символов — в теле конец, первой строкой «…», ≤ 4096", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    const message = `${"д".repeat(8990)}Какой цвет?`;
    await stop(payload({ last_assistant_message: message }));
    const text = bot.calls[0].text;
    assert(text.length <= 4096, `${text.length}`);
    const lines = text.split("\n");
    expect(lines[0]).toStrictEqual(HEAD_A);
    expect(lines[1]).toBe("…");
    expect(lines.at(-2)?.endsWith("дКакой цвет?")).toBe(true);
    expect(lines.at(-1)).toStrictEqual(NO_CHANNEL_LINE);
  });
});

it("пустое последнее сообщение — «(без текста)»", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload({ last_assistant_message: "" }));
    expect(bot.calls[0].text).toStrictEqual(
      `${HEAD_A}\n(без текста)\n${NO_CHANNEL_LINE}`,
    );
  });
});

describe("заголовок: без названия — проект первым; ничего — «💬 сессия»", () => {
  it("ozon, вне tmux", () =>
    withStopDesk(
      async ({ bot, payload, stop }) => {
        await stop(payload(), {});
        expect(bot.calls[0].text.split("\n")[0]).toBe("💬 ozon");
      },
      { lines: [] },
    ));
  it("ничего", () =>
    withStopDesk(async ({ bot, stop }) => {
      await stop('{"last_assistant_message":"Готово."}', {});
      expect(bot.calls[0].text.split("\n")[0]).toBe("💬 сессия");
    }));
});

/** Живой порядок вокруг `Stop`: ввод, затем ответ, записанный после хука. */
async function aroundStop(): Promise<readonly string[]> {
  const text = await readFile(testdata("transcript-around-stop.jsonl"), "utf8");
  return text.split("\n").filter((line) => line !== "");
}

describe("R2a-8, R2a2-1–4: снимает только набранный ввод; assistant после хука и tool_result — нет", async () => {
  // Данные случаев — из голдена, поэтому он читается при сборе: Vitest
  // дожидается асинхронной фабрики `describe` до первого случая.
  const [typed, answer] = await aroundStop();
  for (const [name, record] of [
    // Живой ввод из голдена: снимает, будучи дописанным после постановки.
    ["2: user строкой", typed],
    [
      "3: user блоком text",
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Синий"}]}}',
    ],
  ] as const) {
    it(name, () =>
      withStopDesk(
        async ({ bot, clock, append, payload, stop }) => {
          await stop(payload());
          await clock.paused(WATCH_MS);
          // 1: ответ хода дописан после вызова хука — не ввод.
          await append(answer);
          await turn(clock, bot, 1);
          // 4: ответ инструмента — не ввод.
          await append(
            '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_X"}]}}',
          );
          await append('{"type":"system","subtype":"stop_hook_summary"}');
          await turn(clock, bot, 1);
          await append(record);
          // Снятие — одним оборотом после записи: не позже 2 с.
          await withdrawnBy(clock, bot, 1);
          expect(bot.calls[1]).toStrictEqual({
            method: "edit",
            message: 1546,
            text: `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}\n✅ решено в терминале`,
            buttons: [],
            data: [],
          });
        },
        { lines: [TITLED[0], typed] },
      ),
    );
  }
});

it("R2a-9: второй Stop той же сессии — прежний «решено в терминале», новый поставлен", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload());
    await stop(payload({ last_assistant_message: "Какой размер?" }));
    await bot.called(3);
    expect(bot.calls.slice(1)).toStrictEqual([
      {
        method: "edit",
        message: 1546,
        text: `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}\n✅ решено в терминале`,
        buttons: [],
        data: [],
      },
      {
        method: "send",
        message: 0,
        text: `${HEAD_A}\nКакой размер?\n${NO_CHANNEL_LINE}`,
        buttons: [["Пропустить"]],
        data: [["r1:2:0:skip"]],
      },
    ]);
  });
});

it("Stop другой сессии — прежний не снят: оба ждут", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload());
    await stop(payload(), {
      ...ENV_A,
      CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/9.sock",
    });
    await bot.called(2);
    expect(bot.calls[1].method).toBe("edit");
    expect(bot.calls[1].text.endsWith("ещё ждут: 1")).toBe(true);
  });
});

it("R2a-7: «Пропустить» — «⏭ пропущено», кнопок нет; текст в чат — «ответьте в терминале»", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload());
    bot.deliver([textUpdate(1, 111, "Синий", 1)]);
    await bot.called(2);
    expect(bot.calls[1].text).toBe("ответьте в терминале");
    bot.deliver([pressUpdate(2, 111, "r1:1:0:skip")]);
    await bot.called(4);
    expect(bot.calls[3].text).toStrictEqual(
      `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}\n⏭ пропущено`,
    );
    expect(bot.calls[3].buttons).toStrictEqual([]);
  });
});

it("R2a-13: бот не настроен — причина в stderr, код ответа тот же", async () => {
  const desk = new StopDesk({
    questions: NO_BOT,
    transcripts: new Transcripts({ files: DISK_FILES, clock: new TestClock() }),
    windows: NO_WINDOWS,
    sessions: new Sessions(new TestClock()),
    diagnose: () => {},
  });
  const reply = await desk.reply(
    await readFile(testdata("live-stop.json"), "utf8"),
    () => undefined,
  );
  let stderr = "";
  let stdout = "";
  reply.tell({
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  expect([stdout, stderr]).toStrictEqual([
    "",
    `${NO_QUESTION}бот не настроен\n`,
  ]);
  await desk.stop();
});

it("бот недоступен — причина в stderr", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    bot.fail("send", new BotFailure("401 Unauthorized", 401));
    expect(await stop(payload())).toStrictEqual({
      stdout: "",
      stderr: `${NO_QUESTION}бот недоступен: 401 Unauthorized\n`,
    });
  });
});

it("за срочным — хук вышел, не дождавшись показа своего сообщения", async () => {
  await withStopDesk(async ({ bot, payload, stop, urgent }) => {
    const b = urgent();
    await bot.called(1);
    expect(await stop(payload())).toStrictEqual(SILENT);
    await bot.called(2);
    // Своего сообщения нет — только счётчик у срочного.
    expect(bot.calls.filter((call) => call.method === "send").length).toBe(1);
    b.expire();
    await bot.called(4);
    expect(bot.calls[3].text.split("\n")[0]).toStrictEqual(HEAD_A);
  });
});

it("значение ключа сессии не попадает ни в чат, ни в вывод, ни в журнал", async () => {
  await withStopDesk(async ({ bot, log, payload, stop, desk }) => {
    const told = await stop(payload());
    await stop(payload({ stop_hook_active: true }));
    await stop("{");
    await desk.stop();
    const seen = [
      told.stdout,
      told.stderr,
      ...log,
      ...bot.calls.map((call) => JSON.stringify(call)),
    ].join("\n");
    expect(seen.includes(SOCKET_A)).toBe(false);
    expect(seen.includes("4242.sock")).toBe(false);
  });
});

it("остановка ядра — вопрос «истёк», наблюдатель погашен", async () => {
  await withStopDesk(async ({ bot, clock, payload, stop, desk }) => {
    await stop(payload());
    await clock.paused(WATCH_MS);
    await desk.stop();
    await bot.called(2);
    expect(bot.calls[1].text.split("\n").at(-1)).toBe(
      "⌛ истёк — ответьте в терминале",
    );
  });
});

it("стол остановлен до вопроса — вопрос истёк сразу, в чат ничего, хук молчит", async () => {
  await withStopDesk(async ({ bot, payload, stop, desk }) => {
    await desk.stop();
    expect(await stop(payload())).toStrictEqual(SILENT);
    await desk.stop();
    expect(bot.calls).toStrictEqual([]);
  });
});

it("сбой наблюдателя — строка в журнал службы, вопрос остаётся", async () => {
  const bot = new FakeBot();
  const log: string[] = [];
  const questions = fakeQuestions(bot);
  const clock = new TestClock();
  const desk = new StopDesk({
    questions,
    transcripts: new Transcripts({
      files: {
        read: () => Promise.resolve(new Uint8Array()),
        readFrom: () => Promise.reject(new Error("диск сломался")),
      },
      clock,
    }),
    windows: NO_WINDOWS,
    sessions: new Sessions(clock),
    diagnose: (line) => log.push(line),
  });
  questions.start();
  try {
    const live = await readFile(testdata("live-stop.json"), "utf8");
    await desk.reply(live, () => undefined);
    await clock.paused(WATCH_MS);
    clock.fire(WATCH_MS);
    await desk.reply(live, () => undefined);
    await bot.called(2);
    expect(log).toStrictEqual([
      "claude-hook stop: наблюдатель: Error: диск сломался",
    ]);
    // Первый вопрос не снят: правки «решено в терминале» нет.
    expect(bot.calls.map((call) => call.method)).toStrictEqual([
      "send",
      "edit",
    ]);
    expect(bot.calls[1].text.endsWith("ещё ждут: 1")).toBe(true);
  } finally {
    await desk.stop();
    await questions.stop();
  }
});

/** Сессия B: свой сокет, транскрипта нет — снимается только Stop или чатом. */
const ENV_B = {
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/9.sock",
};

it("дубль-1: пришёл «ждёт» другой сессии — у показанного правка «ещё ждут: 1», нового сообщения нет", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload());
    await stop(
      payload({ last_assistant_message: "B ждёт", transcript_path: "/нет" }),
      ENV_B,
    );
    await bot.called(2);
    expect(bot.calls.map((call) => [call.method, call.message])).toStrictEqual([
      ["send", 0],
      ["edit", 1546],
    ]);
    expect(bot.calls[1].text.endsWith("ещё ждут: 1")).toBe(true);
    expect(bot.twoWithButtons()).toBe("");
  });
});

it("дубль-2: показанный снят набранным вводом, новый Stop той же сессии — у прежнего одно сообщение, новый — одним новым", async () => {
  const [typed] = await aroundStop();
  await withStopDesk(async ({ bot, clock, append, payload, stop }) => {
    await stop(payload());
    const b = payload({
      last_assistant_message: "B ждёт",
      transcript_path: "/нет",
    });
    await stop(b, ENV_B);
    await bot.called(2);
    await clock.paused(WATCH_MS);
    await append(typed);
    await withdrawnBy(clock, bot, 2);
    await stop(payload({ last_assistant_message: "Принято: синий." }));
    // Второй Stop сессии B снимает B — новый A становится активным.
    await stop(b, ENV_B);
    await bot.called(7);
    const A = `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}`;
    const B = `💬 ozon\nB ждёт\n${NO_CHANNEL_LINE}`;
    const A2 = `${HEAD_A}\nПринято: синий.\n${NO_CHANNEL_LINE}`;
    expect(
      bot.calls.map((call) => [call.method, call.message, call.text]),
    ).toStrictEqual([
      ["send", 0, A],
      ["edit", 1546, `${A}\nещё ждут: 1`],
      ["edit", 1546, `${A}\n✅ решено в терминале`],
      ["send", 0, B],
      ["edit", 1547, `${B}\nещё ждут: 1`],
      ["edit", 1547, `${B}\n✅ решено в терминале`],
      ["send", 0, `${A2}\nещё ждут: 1`],
    ]);
    expect(bot.twoWithButtons()).toBe("");
  });
});
