/**
 * Вопрос «ждёт ввода» хука `Stop` целиком: payload → сообщение в чате →
 * хук вышел; снятие транскриптом, новым концом хода, остановкой ядра
 * (`claude-hook-stop.md`; сценарии постановки R2a — номерами в именах
 * тестов). Бот — фейк, транскрипт — файл во временном каталоге, часы
 * наблюдателя ведёт тест.
 */

import { assert, assertEquals } from "@std/assert";
import { type Asked, NO_BOT } from "../botquestions/mod.ts";
import { BotFailure } from "../botquestions/bot_api.ts";
import {
  f1,
  FakeBot,
  fakeQuestions,
  pressUpdate,
  textUpdate,
} from "../botquestions/testbot.ts";
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
  const dir = await Deno.makeTempDir();
  const transcript = `${dir}/session.jsonl`;
  await Deno.writeTextFile(
    transcript,
    (options.lines ?? TITLED).map((line) => `${line}\n`).join(""),
  );
  const live = JSON.parse(await Deno.readTextFile(testdata("live-stop.json")));
  const bot = new FakeBot();
  const log: string[] = [];
  const questions = fakeQuestions(bot);
  const clock = new TestClock();
  const desk = new StopDesk({
    questions,
    transcripts: new Transcripts({ files: DISK_FILES, clock }),
    windows: new Windows(TMUX_A),
    sessions: new Sessions(),
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
      append: (line) =>
        Deno.writeTextFile(transcript, `${line}\n`, { append: true }),
      payload: (over = {}) =>
        JSON.stringify({ ...live, transcript_path: transcript, ...over }),
      stop,
      desk,
    });
  } finally {
    await desk.stop();
    await questions.stop();
    await Deno.remove(dir, { recursive: true });
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
  assertEquals(first, "ждёт", "вопрос снят записью, которая не набранный ввод");
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
  assertEquals(first, "снят", "набранный ввод не снял вопрос за один оборот");
}

Deno.test("R2a-1: конец хода — сообщение «ждёт ввода», хук вышел до ответа: stdout пуст", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    const told = await stop(payload());
    assertEquals(told, SILENT);
    // Хук вышел, а в чате — ровно показ, ни одного апдейта не было.
    assertEquals(bot.calls, [{
      method: "send",
      message: 0,
      text: `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}`,
      buttons: [["Пропустить"]],
      data: [["r1:1:0:skip"]],
    }]);
  });
});

Deno.test("R2a-2: продолжение хода (stop_hook_active) — в чат ничего", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    assertEquals(await stop(payload({ stop_hook_active: true })), {
      stdout: "",
      stderr: `${NO_QUESTION}продолжение хода\n`,
    });
    assertEquals(bot.calls, []);
  });
});

Deno.test("вход не разобран — причина; в чат ничего", async (t) => {
  for (
    const [name, stdin, what] of [
      ["не JSON", "{", "stdin — не JSON-объект"],
      ["массив", "[]", "stdin — не JSON-объект"],
      [
        "нет last_assistant_message",
        '{"hook_event_name":"Stop"}',
        "нет last_assistant_message",
      ],
    ] as const
  ) {
    await t.step(name, () =>
      withStopDesk(async ({ bot, stop }) => {
        assertEquals(await stop(stdin), {
          stdout: "",
          stderr: `${NO_QUESTION}вход не разобран: ${what}\n`,
        });
        assertEquals(bot.calls, []);
      }));
  }
});

Deno.test("R2a-3: сообщение в 9000 символов — в теле конец, первой строкой «…», ≤ 4096", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    const message = `${"д".repeat(8990)}Какой цвет?`;
    await stop(payload({ last_assistant_message: message }));
    const text = bot.calls[0].text;
    assert(text.length <= 4096, `${text.length}`);
    const lines = text.split("\n");
    assertEquals(lines[0], HEAD_A);
    assertEquals(lines[1], "…");
    assertEquals(lines.at(-2)?.endsWith("дКакой цвет?"), true);
    assertEquals(lines.at(-1), NO_CHANNEL_LINE);
  });
});

Deno.test("пустое последнее сообщение — «(без текста)»", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload({ last_assistant_message: "" }));
    assertEquals(
      bot.calls[0].text,
      `${HEAD_A}\n(без текста)\n${NO_CHANNEL_LINE}`,
    );
  });
});

Deno.test("заголовок: без названия — проект первым; ничего — «💬 сессия»", async (t) => {
  await t.step(
    "ozon, вне tmux",
    () =>
      withStopDesk(async ({ bot, payload, stop }) => {
        await stop(payload(), {});
        assertEquals(bot.calls[0].text.split("\n")[0], "💬 ozon");
      }, { lines: [] }),
  );
  await t.step("ничего", () =>
    withStopDesk(async ({ bot, stop }) => {
      await stop('{"last_assistant_message":"Готово."}', {});
      assertEquals(bot.calls[0].text.split("\n")[0], "💬 сессия");
    }));
});

/** Живой порядок вокруг `Stop`: ввод, затем ответ, записанный после хука. */
async function aroundStop(): Promise<readonly string[]> {
  const text = await Deno.readTextFile(
    testdata("transcript-around-stop.jsonl"),
  );
  return text.split("\n").filter((line) => line !== "");
}

Deno.test("R2a-8, R2a2-1–4: снимает только набранный ввод; assistant после хука и tool_result — нет", async (t) => {
  const [typed, answer] = await aroundStop();
  for (
    const [name, record] of [
      // Живой ввод из голдена: снимает, будучи дописанным после постановки.
      ["2: user строкой", typed],
      [
        "3: user блоком text",
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Синий"}]}}',
      ],
    ] as const
  ) {
    await t.step(
      name,
      () =>
        withStopDesk(async ({ bot, clock, append, payload, stop }) => {
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
          assertEquals(bot.calls[1], {
            method: "edit",
            message: 1546,
            text:
              `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}\n✅ решено в терминале`,
            buttons: [],
            data: [],
          });
        }, { lines: [TITLED[0], typed] }),
    );
  }
});

Deno.test("R2a-9: второй Stop той же сессии — прежний «решено в терминале», новый поставлен", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload());
    await stop(payload({ last_assistant_message: "Какой размер?" }));
    await bot.called(3);
    assertEquals(bot.calls.slice(1), [
      {
        method: "edit",
        message: 1546,
        text:
          `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}\n✅ решено в терминале`,
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

Deno.test("Stop другой сессии — прежний не снят: оба ждут", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload());
    await stop(payload(), {
      ...ENV_A,
      CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/9.sock",
    });
    await bot.called(2);
    assertEquals(bot.calls[1].method, "edit");
    assertEquals(bot.calls[1].text.endsWith("ещё ждут: 1"), true);
  });
});

Deno.test("R2a-7: «Пропустить» — «⏭ пропущено», кнопок нет; текст в чат — «ответьте в терминале»", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload());
    bot.deliver([textUpdate(1, 111, "Синий", 1)]);
    await bot.called(2);
    assertEquals(bot.calls[1].text, "ответьте в терминале");
    bot.deliver([pressUpdate(2, 111, "r1:1:0:skip")]);
    await bot.called(4);
    assertEquals(
      bot.calls[3].text,
      `${HEAD_A}\nВы выбрали: Пн.\n${NO_CHANNEL_LINE}\n⏭ пропущено`,
    );
    assertEquals(bot.calls[3].buttons, []);
  });
});

Deno.test("R2a-13: бот не настроен — причина в stderr, код ответа тот же", async () => {
  const desk = new StopDesk({
    questions: NO_BOT,
    transcripts: new Transcripts({ files: DISK_FILES, clock: new TestClock() }),
    windows: NO_WINDOWS,
    sessions: new Sessions(),
    diagnose: () => {},
  });
  const reply = await desk.reply(
    await Deno.readTextFile(testdata("live-stop.json")),
    () => undefined,
  );
  let stderr = "";
  let stdout = "";
  reply.tell({
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  });
  assertEquals([stdout, stderr], ["", `${NO_QUESTION}бот не настроен\n`]);
  await desk.stop();
});

Deno.test("бот недоступен — причина в stderr", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    bot.fail("send", new BotFailure("401 Unauthorized", 401));
    assertEquals(await stop(payload()), {
      stdout: "",
      stderr: `${NO_QUESTION}бот недоступен: 401 Unauthorized\n`,
    });
  });
});

Deno.test("за срочным — хук вышел, не дождавшись показа своего сообщения", async () => {
  await withStopDesk(async ({ bot, payload, stop, urgent }) => {
    const b = urgent();
    await bot.called(1);
    assertEquals(await stop(payload()), SILENT);
    await bot.called(2);
    // Своего сообщения нет — только счётчик у срочного.
    assertEquals(
      bot.calls.filter((call) => call.method === "send").length,
      1,
    );
    b.expire();
    await bot.called(4);
    assertEquals(bot.calls[3].text.split("\n")[0], HEAD_A);
  });
});

Deno.test("значение ключа сессии не попадает ни в чат, ни в вывод, ни в журнал", async () => {
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
    assertEquals(seen.includes(SOCKET_A), false);
    assertEquals(seen.includes("4242.sock"), false);
  });
});

Deno.test("остановка ядра — вопрос «истёк», наблюдатель погашен", async () => {
  await withStopDesk(async ({ bot, clock, payload, stop, desk }) => {
    await stop(payload());
    await clock.paused(WATCH_MS);
    await desk.stop();
    await bot.called(2);
    assertEquals(
      bot.calls[1].text.split("\n").at(-1),
      "⌛ истёк — ответьте в терминале",
    );
  });
});

Deno.test("стол остановлен до вопроса — вопрос истёк сразу, в чат ничего, хук молчит", async () => {
  await withStopDesk(async ({ bot, payload, stop, desk }) => {
    await desk.stop();
    assertEquals(await stop(payload()), SILENT);
    await desk.stop();
    assertEquals(bot.calls, []);
  });
});

Deno.test("сбой наблюдателя — строка в журнал службы, вопрос остаётся", async () => {
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
    sessions: new Sessions(),
    diagnose: (line) => log.push(line),
  });
  questions.start();
  try {
    const live = await Deno.readTextFile(testdata("live-stop.json"));
    await desk.reply(live, () => undefined);
    await clock.paused(WATCH_MS);
    clock.fire(WATCH_MS);
    await desk.reply(live, () => undefined);
    await bot.called(2);
    assertEquals(log, ["claude-hook stop: наблюдатель: Error: диск сломался"]);
    // Первый вопрос не снят: правки «решено в терминале» нет.
    assertEquals(bot.calls.map((call) => call.method), ["send", "edit"]);
    assertEquals(bot.calls[1].text.endsWith("ещё ждут: 1"), true);
  } finally {
    await desk.stop();
    await questions.stop();
  }
});

/** Сессия B: свой сокет, транскрипта нет — снимается только Stop или чатом. */
const ENV_B = {
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/9.sock",
};

Deno.test("дубль-1: пришёл «ждёт» другой сессии — у показанного правка «ещё ждут: 1», нового сообщения нет", async () => {
  await withStopDesk(async ({ bot, payload, stop }) => {
    await stop(payload());
    await stop(
      payload({ last_assistant_message: "B ждёт", transcript_path: "/нет" }),
      ENV_B,
    );
    await bot.called(2);
    assertEquals(bot.calls.map((call) => [call.method, call.message]), [
      ["send", 0],
      ["edit", 1546],
    ]);
    assertEquals(bot.calls[1].text.endsWith("ещё ждут: 1"), true);
    assertEquals(bot.twoWithButtons(), "");
  });
});

Deno.test("дубль-2: показанный снят набранным вводом, новый Stop той же сессии — у прежнего одно сообщение, новый — одним новым", async () => {
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
    assertEquals(
      bot.calls.map((call) => [call.method, call.message, call.text]),
      [
        ["send", 0, A],
        ["edit", 1546, `${A}\nещё ждут: 1`],
        ["edit", 1546, `${A}\n✅ решено в терминале`],
        ["send", 0, B],
        ["edit", 1547, `${B}\nещё ждут: 1`],
        ["edit", 1547, `${B}\n✅ решено в терминале`],
        ["send", 0, `${A2}\nещё ждут: 1`],
      ],
    );
    assertEquals(bot.twoWithButtons(), "");
  });
});
