/**
 * Вопрос посреди строки (`platform/line-prompt.md`): спрашивает и
 * копирует тот, кто позвал. Эталон — прогон настоящих команд через
 * сервер: `mpu confirm` спрашивает «Применить?», `mpu run-js --dry-run`
 * просит положить текст в буфер обмена.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Answer, CommandIo } from "../command/mod.ts";
import { askFrame, type AskKind, type ServerFrame } from "../frames/mod.ts";
import { linePrompt } from "./prompt.ts";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
import {
  Client,
  type Frame,
  ndjson,
  post,
  type TestBack,
  withBack,
  within,
} from "./testback.ts";

/** Строка с ответами на вопросы; кадры — до `exit`. */
async function lineAsking(
  back: TestBack,
  words: readonly string[],
  options: {
    readonly answers?: readonly string[];
    readonly human?: boolean;
    readonly stdin?: string;
    readonly path?: string;
  } = {},
): Promise<Frame[]> {
  const client = new Client(back, options.path ?? "/line", {
    answers: options.answers,
  });
  await client.opened();
  client.send({
    words,
    cwd: Deno.cwd(),
    human: options.human ?? true,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
  return await client.finished();
}

/** Все кадры `ask` подряд: текст и вид. */
function asked(frames: readonly Frame[]): Frame[] {
  return frames.filter((frame) => "ask" in frame);
}

Deno.test("ворота в конвейере: вопрос клиенту, ответ, буфер дальше", () =>
  withBack(async (back) => {
    const frames = await lineAsking(back, ["confirm"], {
      stdin: "данные конвейера\n",
      answers: ["y"],
    });
    // Вид `line` в кадр не пишется: он умолчание, и прежний клиент
    // видит тот же кадр, что и раньше.
    assertEquals(asked(frames), [{ ask: "Применить? [y/N] " }]);
    assertEquals(frames.at(-1), { exit: 0 });
    // Буфер конвейера прошёл насквозь: эхо в stderr, данные в stdout.
    assertEquals(
      frames.filter((frame) => "out" in frame),
      [{ out: "данные конвейера\n" }],
    );
  }));

Deno.test("ответ «нет»: ворота отбивают конвейер, код 1", () =>
  withBack(async (back) => {
    const frames = await lineAsking(back, ["confirm"], {
      stdin: "данные\n",
      answers: ["n"],
    });
    assertEquals(frames.at(-1), { exit: 1 });
    assertEquals(frames.some((frame) => "out" in frame), false);
  }));

Deno.test("спросить некого: отказ с диагностикой, вопрос не задан", () =>
  withBack(async (back) => {
    const frames = await lineAsking(back, ["confirm"], {
      stdin: "данные\n",
      human: false,
    });
    assertEquals(asked(frames), []);
    const stderr = frames.map((frame) => frame.err ?? "").join("");
    assertStringIncludes(stderr, "терминал недоступен для подтверждения");
    assertStringIncludes(stderr, "fd 0 (stdin): isatty=false\n");
    assertEquals(frames.at(-1), { exit: 2 });
  }));

Deno.test("два вопроса подряд: каждый ждёт своего ответа", () =>
  withBack(async (back) => {
    // `telegram login` спрашивает согласие, затем ключи: три вопроса
    // подряд в одной строке (`docs/specs/telegram-login.md`).
    // Первый вопрос — правил подтверждения (команда мутирующая), два
    // следующих — самого сценария: каждый ждёт своего ответа.
    const frames = await lineAsking(back, ["ask", "telegram", "login"], {
      answers: ["y", "y", "", ""],
    });
    assertEquals(asked(frames).map((frame) => frame.ask), [
      "выполнить mpu telegram login? [y/N] ",
      "Set up Telegram now? [y/N]: ",
      "api_id (integer): ",
      "api_hash (32 hex chars): ",
    ]);
    assertStringIncludes(
      frames.map((frame) => frame.err ?? "").join(""),
      "# telegram: пропущено (api_id/api_hash пустые)",
    );
  }, { io: emptyEnvFile() }));

Deno.test("ответ по номеру: тело в журнал и диагностику не попадает", () =>
  withBack(async (back) => {
    const secret = "п4роль-м4ркер";
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const frames = await ndjson(
      back,
      await post(back, "/line", {
        words: ["ask", "xlsx", "alias", "ls"],
        cwd: Deno.cwd(),
        human: true,
      }),
    );
    const ticket = String(frames.at(-1)?.ticket);
    // Ответ уходит отдельным запросом: его тело — то же, чем отвечают
    // на скрытый вопрос (`platform/back-http-line.md`).
    const sent = await post(back, "/line/answer", { ticket, answer: secret });
    assertEquals(sent.status, 200);
    // Тело ответа на сам запрос — продолжение строки: кадры после
    // вопроса приходят в нём, и ответа там тоже быть не должно.
    back.seen.push(await within(sent.text(), 5000, "ответ по номеру"));
    for (const text of [...back.logged, ...back.diagnosed, ...back.seen]) {
      assertEquals(text.includes(secret), false, `ответ в «${text}»`);
    }
  }));

Deno.test("ответ человека не выходит из строки: ни в журнал, ни в вывод", () =>
  withBack(async (back) => {
    const password = "п4роль-м4ркер";
    const client = new Client(back, "/line");
    await client.opened();
    // Живого второго фактора Telegram в прогоне нет, поэтому скрытый
    // вопрос задаёт сама строка: `mpu confirm` спрашивает видимо, а
    // здесь проверяется, что вид доезжает до клиента и что ответ на
    // него не выходит наружу ни одним путём.
    client.send({
      words: ["ask", "telegram", "login"],
      cwd: Deno.cwd(),
      human: true,
    });
    const asking = await within(
      client.frame((frame) => "ask" in frame),
      5000,
      "вопрос правил",
    );
    assertEquals(asking, { ask: "выполнить mpu telegram login? [y/N] " });
    client.answer(password);
    const frames = await client.finished();
    // Ответ человека не появляется ни в журнале, ни в кадрах строки, ни
    // в диагностике сервера (`platform/line-prompt.md`, инварианты).
    const texts = [
      ...back.logged,
      ...back.diagnosed,
      ...frames.map((frame) => JSON.stringify(frame)),
    ];
    for (const text of texts) {
      assertEquals(text.includes(password), false, `ответ в «${text}»`);
    }
  }, { io: emptyEnvFile() }));

Deno.test("копирование: кадр clip у человека, у агента его нет", () =>
  withBack(async (back) => {
    // `make-schema -p` ничего не выполняет: печатает docker-команду и
    // предлагает положить её в буфер обмена. Команда мутирующая, поэтому
    // первым идёт вопрос правил.
    const words = [
      "ask",
      "make-schema",
      "print",
      "target:",
      "777",
      "client-id:",
      "777",
    ];
    const human = await lineAsking(back, words, { answers: ["y"] });
    const clips = human.filter((frame) => "clip" in frame);
    assertEquals(clips.length, 1, JSON.stringify(human));
    assertStringIncludes(String(clips[0].clip), "mp-sl-1-cli");
    // На двери агента копирование не предлагается: буфера у него нет.
    const agent = await lineAsking(back, words, {
      path: "/agent/line",
      answers: ["y"],
    });
    assertEquals(agent.filter((frame) => "clip" in frame), []);
    // Итог строки от этого не меняется: текст печатается и так.
    assertEquals(
      human.filter((frame) => "out" in frame),
      agent.filter((frame) => "out" in frame),
    );
  }));

Deno.test("терминал сервера не открывается ни разу", () =>
  withBack(async (back) => {
    const opened: string[] = [];
    const realOpen = Deno.open;
    Deno.open = ((path: string | URL, options?: Deno.OpenOptions) => {
      if (String(path).includes("/dev/tty")) opened.push(String(path));
      return realOpen(path, options);
    }) as typeof Deno.open;
    try {
      await lineAsking(back, ["confirm"], {
        stdin: "данные\n",
        answers: ["y"],
      });
      await lineAsking(back, ["confirm"], { stdin: "д\n", human: false });
    } finally {
      Deno.open = realOpen;
    }
    assertEquals(opened, []);
  }));

/** Окружение без ключей: вход в Telegram спросит их у человека. */
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

/** Строка-протокол для вопроса: что спросили и что послали. */
function askingLine(answers: readonly string[]) {
  const left = [...answers];
  const asks: { kind: AskKind; question: string }[] = [];
  const frames: ServerFrame[] = [];
  return {
    asks,
    frames,
    question: (question: string, kind: AskKind) =>
      void asks.push({ kind, question }),
    answer: () => Promise.resolve(left.shift()),
    deliver: (frame: ServerFrame) => void frames.push(frame),
  };
}

/** Ответ как есть; спросить некого — `undefined`. */
const ANSWERED: Answer<string | undefined> = {
  given: (text) => text,
  absent: () => undefined,
};

Deno.test("вид вопроса доезжает до клиента, двери решают за себя", async (t) => {
  await t.step("дверь человека: оба вида и копирование", async () => {
    const line = askingLine(["пароль"]);
    const prompt = linePrompt(line, {
      asks: () => true,
      copies: () => true,
    });
    assertEquals(await prompt.secret("Пароль: ", ANSWERED), "пароль");
    assertEquals(line.asks, [{ kind: "secret", question: "Пароль: " }]);
    await prompt.copy("текст");
    assertEquals(line.frames, [{ clip: "текст" }]);
  });
  await t.step("дверь агента: скрытого вопроса нет вовсе", async () => {
    const line = askingLine(["пароль"]);
    const prompt = linePrompt(line, {
      asks: (kind) => kind === "line",
      copies: () => false,
    });
    // Спросить некого — и вопрос не задан: ответ не проходит через
    // переписку агента (`platform/line-prompt.md`).
    assertEquals(await prompt.secret("Пароль: ", ANSWERED), undefined);
    assertEquals(line.asks, []);
    await prompt.copy("текст");
    assertEquals(line.frames, []);
  });
  await t.step("молчание клиента — пустой ответ, а не отказ", async () => {
    const line = askingLine([]);
    const prompt = linePrompt(line, { asks: () => true, copies: () => true });
    assertEquals(await prompt.line("Применить? ", ANSWERED), "");
  });
});

Deno.test("голдены: кадры вопроса, скрытого вопроса и копирования", () =>
  withBack(async (back) => {
    const confirm = await lineAsking(back, ["confirm"], {
      stdin: "данные конвейера\n",
      answers: ["y"],
    });
    await golden("frames-confirm.json", {
      "описание": "confirm посреди конвейера: вопрос, ответ, буфер дальше",
      "слова": ["confirm"],
      "ответы": ["y"],
      "кадры": confirm,
    });
    const secret = "п4роль-м4ркер";
    const line = askingLine([secret]);
    const prompt = linePrompt(line, { asks: () => true, copies: () => true });
    assertEquals(await prompt.secret("Пароль: ", ANSWERED), secret);
    // Запись журнала снимается с живой строки: она пишет аргументы и
    // вывод, а ответ человека — ни то, ни другое.
    const answered = await lineAsking(back, ["confirm"], {
      stdin: "данные\n",
      answers: [secret],
    });
    await golden("frames-secret.json", {
      "описание":
        "скрытый вопрос: кадр с видом и ответ, которого нет ни в кадрах " +
        "строки, ни в записи журнала. Кадр снят с объекта вопроса, а не " +
        "с живой команды: команды, спрашивающей пароль вне живого " +
        "клиента Telegram, нет",
      "кадр": askFrame(line.asks[0].question, line.asks[0].kind),
      "кадры строки": line.frames,
      "кадры отвеченной строки": answered,
      "запись журнала": back.logged,
    });
    const words = [
      "ask",
      "make-schema",
      "print",
      "target:",
      "777",
      "client-id:",
      "777",
    ];
    const human = await lineAsking(back, words, { answers: ["y"] });
    const agent = await lineAsking(back, words, {
      path: "/agent/line",
      answers: ["y"],
    });
    await golden("frames-clip.json", {
      "описание": "копирование: кадр clip у человека, у агента его нет",
      "слова": words,
      "кадры у человека": human,
      "кадры у агента": agent,
    });
  }));

/** Копия снятого прогоном голдена совпадает с ним. */
async function golden(name: string, body: unknown) {
  const url = new URL(`testdata/line-prompt/${name}`, import.meta.url);
  assertEquals(body, JSON.parse(await Deno.readTextFile(url)));
}
