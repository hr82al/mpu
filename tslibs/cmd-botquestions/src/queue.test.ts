/**
 * Ряд вопросов и сообщение с кнопками
 * (`docs/specs/platform/telegram-questions.md`; сценарии постановки R1a —
 * номерами в именах тестов). Чат — фейк Bot API, вызовы сверяются по
 * порядку.
 */

import { describe, expect, it } from "vitest";
import { BotFailure } from "./bot_api.ts";
import { OptionKey, STALE } from "./button.ts";
import {
  BUTTONS_ONLY,
  Form,
  LATER,
  MANY,
  ONE,
  oneClosing,
  SKIP,
  type StepEvents,
  TAKES_TEXT,
  type TextRule,
} from "./form.ts";
import { WAITS_INPUT } from "./row.ts";
import {
  type OutcomeReader,
  type StepAnswerReader,
  Written,
} from "./outcome.ts";
import { type Asked, Queue } from "./queue.ts";
import {
  ArrayMemory,
  type Call,
  f1,
  f2,
  FakeBot,
  fakeChat,
  step,
} from "./testbot.ts";

/** Ответ шага словами. */
const STEP: StepAnswerReader<string> = {
  picked: (indices) => `вариант ${indices.join(",")}`,
  wrote: (text) => `текст ${text}`,
};

/** Исход словами. */
const OUTCOME: OutcomeReader<string> = {
  answered: (answers) =>
    `ответ: ${answers.map((answer) => answer.read(STEP)).join("; ")}`,
  withdrawn: () => "снят",
  expired: () => "истёк",
  refused: (reason) => `отказ: ${reason}`,
};

/** Ряд на фейке; журнал службы — `log`. */
function setup() {
  const bot = new FakeBot();
  const log: string[] = [];
  const memory = new ArrayMemory();
  const queue = new Queue({
    chat: fakeChat(bot, memory, log),
    run: "r1",
    diagnose: (line) => log.push(line),
  });
  return { bot, log, memory, queue };
}

/** Вызовы с номера `from`. */
function since(bot: FakeBot, from: number): readonly Call[] {
  return bot.calls.slice(from);
}

const F1_TEXT = "🔐 Bash — ozon\nCreate probe file\ntouch /tmp/x1.txt";
const F1_BUTTONS = [["Yes", "Yes, always: Bash(touch /tmp/x1.txt)"], ["No"]];

it("1: вопрос в пустом ряду — одно сообщение с кнопками по две", async () => {
  const { bot, memory, queue } = setup();
  queue.ask(f1());
  await queue.idle();
  expect(bot.calls).toStrictEqual([
    {
      method: "send",
      message: 0,
      text: F1_TEXT,
      buttons: F1_BUTTONS,
      data: [["r1:1:0:0", "r1:1:0:1"], ["r1:1:0:2"]],
    },
  ]);
  expect(memory.ids()).toStrictEqual([1546]);
});

it("2: нажатие — подтверждение первым, исход, правка без кнопок", async () => {
  const { bot, memory, queue } = setup();
  const asked = queue.ask(f1());
  await queue.idle();
  await queue.press("cb1", "r1:1:0:0");
  await queue.idle();
  expect(since(bot, 1)).toStrictEqual([
    { method: "ack", message: 0, text: "", buttons: [], data: [] },
    {
      method: "edit",
      message: 1546,
      text: `${F1_TEXT}\n✅ Yes — из чата`,
      buttons: [],
      data: [],
    },
  ]);
  expect((await asked.outcome).read(OUTCOME)).toBe("ответ: вариант 0");
  expect(memory.ids()).toStrictEqual([]);
});

it("3: текст владельца — ответ шага, строка исхода — потребителя", async () => {
  const { bot, queue } = setup();
  const permission = new Form({
    places: ["ozon"],
    steps: f1().steps,
    answerLine: {
      line: (answers) =>
        answers[0].read({
          picked: () => "✅ Yes — из чата",
          wrote: (text) => `❌ No: ${text} — из чата`,
        }),
    },
  });
  const asked = queue.ask(permission);
  await queue.idle();
  await queue.write("не трогай /tmp");
  await queue.idle();
  expect((await asked.outcome).read(OUTCOME)).toBe(
    "ответ: текст не трогай /tmp",
  );
  expect(bot.calls.at(-1)?.text).toStrictEqual(
    `${F1_TEXT}\n❌ No: не трогай /tmp — из чата`,
  );
});

it("5: повтор нажатия и кнопка прошлого запуска — «вопрос уже решён»", async () => {
  const { bot, queue } = setup();
  const asked = queue.ask(f1());
  await queue.idle();
  await queue.press("cb0", "zz:1:0:0");
  await queue.press("cb1", "r1:1:0:2");
  await queue.idle();
  const before = bot.calls.length;
  await queue.press("cb1", "r1:1:0:2");
  await queue.press("cb2", "r1:1:0:0");
  await queue.idle();
  expect(bot.calls[1].text).toBe("вопрос уже решён");
  expect(
    since(bot, before).map((call) => [call.method, call.text]),
  ).toStrictEqual([
    ["ack", "вопрос уже решён"],
    ["ack", "вопрос уже решён"],
  ]);
  expect((await asked.outcome).read(OUTCOME)).toBe("ответ: вариант 2");
});

it("6: второй вопрос — «ещё ждут: 1» правкой с кнопками, после исхода — новым сообщением", async () => {
  const { bot, queue } = setup();
  queue.ask(f1());
  await queue.idle();
  queue.ask(f2());
  await queue.idle();
  expect(bot.calls.map((call) => call.method)).toStrictEqual(["send", "edit"]);
  expect(bot.calls[1].text).toStrictEqual(`${F1_TEXT}\nещё ждут: 1`);
  // Правка счётчика без кнопок сняла бы их: Bot API без `reply_markup`
  // убирает клавиатуру.
  expect(bot.calls[1].buttons).toStrictEqual(F1_BUTTONS);
  await queue.press("cb1", "r1:1:0:0");
  await queue.idle();
  expect(
    since(bot, 2).map((call) => [call.method, call.message]),
  ).toStrictEqual([
    ["ack", 0],
    ["edit", 1546],
    ["send", 0],
  ]);
  expect(bot.calls[3].text).toStrictEqual(`${F1_TEXT}\n✅ Yes — из чата`);
  expect(bot.calls[4].text).toBe("🔐 Bash — sl-back\nls");
  expect(bot.calls[4].data).toStrictEqual([["r1:2:0:0", "r1:2:0:1"]]);
});

it("7: ожидающий снят до показа — строка «ещё ждут» убрана, нового сообщения нет", async () => {
  const { bot, queue } = setup();
  queue.ask(f1());
  const second = queue.ask(f2());
  await queue.idle();
  second.withdraw("решено в терминале");
  await queue.idle();
  expect((await second.outcome).read(OUTCOME)).toBe("снят");
  expect(bot.calls.at(-1)).toStrictEqual({
    method: "edit",
    message: 1546,
    text: F1_TEXT,
    buttons: F1_BUTTONS,
    data: [["r1:1:0:0", "r1:1:0:1"], ["r1:1:0:2"]],
  });
  const before = bot.calls.length;
  await queue.press("cb1", "r1:1:0:0");
  await queue.idle();
  expect(since(bot, before).map((call) => call.method)).toStrictEqual([
    "ack",
    "edit",
  ]);
});

it("снят показанный — правка строкой снятия; истёк — строкой истечения", async () => {
  const { bot, queue } = setup();
  const first = queue.ask(f1());
  await queue.idle();
  first.withdraw("решено в терминале");
  await queue.idle();
  expect(bot.calls.at(-1)?.text).toStrictEqual(
    `${F1_TEXT}\n✅ решено в терминале`,
  );
  const second = queue.ask(f1());
  await queue.idle();
  second.expire();
  await queue.idle();
  expect(bot.calls.at(-1)?.text).toStrictEqual(
    `${F1_TEXT}\n⌛ истёк — ответьте в терминале`,
  );
  expect((await second.outcome).read(OUTCOME)).toBe("истёк");
  // Второй исход ничего не меняет: исход у вопроса один.
  const before = bot.calls.length;
  second.withdraw("решено в терминале");
  await queue.idle();
  expect(bot.calls.length).toStrictEqual(before);
});

/** Форма с шагом «несколько» `S`, `M`. */
function sizes(): Form {
  return new Form({
    places: ["ozon"],
    steps: [
      {
        head: "❓ Размер",
        text: "Какой размер?",
        options: [{ label: "S" }, { label: "M" }],
        choice: MANY,
        reply: TAKES_TEXT,
      },
    ],
  });
}

it("8: несколько — отметки правкой, «Готово» без отметок — подсказка", async () => {
  const { bot, queue } = setup();
  const asked = queue.ask(sizes());
  await queue.idle();
  expect(bot.calls[0].buttons).toStrictEqual([["☐ S", "☐ M"], ["Готово"]]);
  await queue.press("a", "r1:1:0:ok");
  await queue.idle();
  expect(bot.calls.at(-1)?.text).toBe("отметьте хотя бы один вариант");
  await queue.press("b", "r1:1:0:0");
  await queue.idle();
  expect(bot.calls.at(-1)?.buttons).toStrictEqual([["☑ S", "☐ M"], ["Готово"]]);
  await queue.press("c", "r1:1:0:1");
  await queue.press("d", "r1:1:0:ok");
  await queue.idle();
  expect((await asked.outcome).read(OUTCOME)).toBe("ответ: вариант 0,1");
  expect(bot.calls.at(-1)?.text).toBe(
    "❓ Размер — ozon\nКакой размер?\n✅ S, M — из чата",
  );
});

it("9: два шага — то же сообщение правится на шаг 2, исход один, после последнего", async () => {
  const { bot, queue } = setup();
  const asked = queue.ask(
    new Form({
      places: ["ozon"],
      steps: [
        {
          head: "❓ Цвет",
          text: "Какой цвет?",
          options: [
            { label: "Красный", description: "Красный цвет" },
            { label: "Синий", description: "Синий цвет" },
          ],
          choice: ONE,
          reply: TAKES_TEXT,
        },
        step("❓ Цвет", "Какой размер?", ["S", "M"]),
      ],
    }),
  );
  let settled = false;
  const watched = asked.outcome.then(() => {
    settled = true;
  });
  await queue.idle();
  expect(bot.calls[0].text).toBe(
    "❓ Цвет 1/2 — ozon\nКакой цвет?\n• Красный — Красный цвет\n• Синий — Синий цвет",
  );
  await queue.press("a", "r1:1:0:1");
  await queue.idle();
  expect(settled).toBe(false);
  expect(bot.calls.at(-1)).toStrictEqual({
    method: "edit",
    message: 1546,
    text: "❓ Цвет 2/2 — ozon\nКакой размер?",
    buttons: [["S", "M"]],
    data: [["r1:1:1:0", "r1:1:1:1"]],
  });
  // Повтор нажатия шага 1 шагу 2 не отвечает.
  await queue.press("a", "r1:1:0:1");
  await queue.idle();
  expect(bot.calls.at(-1)?.text).toBe("вопрос уже решён");
  expect(settled).toBe(false);
  await queue.press("b", "r1:1:1:0");
  await watched;
  expect((await asked.outcome).read(OUTCOME)).toBe(
    "ответ: вариант 1; вариант 0",
  );
  await queue.idle();
  // Строка ответа многошагового — ответы шагов через `; ` («Уточнения R1a»).
  expect(bot.calls.at(-1)?.text).toBe(
    "❓ Цвет 2/2 — ozon\nКакой размер?\n✅ Синий; S — из чата",
  );
  expect(bot.calls.filter((call) => call.method === "send").length).toBe(1);
});

/** Два шага; последний вариант каждого отвечает всю форму. */
function closingForm(): Form {
  const closing = (head: string, labels: readonly string[]) => ({
    head,
    text: "?",
    options: labels.map((label) => ({ label })),
    choice: oneClosing(1),
    reply: BUTTONS_ONLY,
  });
  return new Form({
    places: [],
    steps: [
      closing("📝 a", ["x", "y", "Decline"]),
      closing("📝 a", ["z", "Decline"]),
    ],
  });
}

describe("вид «один, последние кончают форму»: следующих шагов нет", () => {
  for (const [name, presses, outcome] of [
    ["кончающий на первом шаге", ["r1:1:0:2"], "ответ: вариант 2"],
    [
      "обычный, затем кончающий",
      ["r1:1:0:0", "r1:1:1:1"],
      "ответ: вариант 0; вариант 1",
    ],
    [
      "обычные до конца",
      ["r1:1:0:1", "r1:1:1:0"],
      "ответ: вариант 1; вариант 0",
    ],
  ] as const) {
    it(name, async () => {
      const { bot, queue } = setup();
      const asked = queue.ask(closingForm());
      await queue.idle();
      for (const data of presses) {
        await queue.press("c", data);
        await queue.idle();
      }
      expect((await asked.outcome).read(OUTCOME)).toStrictEqual(outcome);
      expect(bot.buttonedNow()).toBe(0);
    });
  }
});

it("подпись в 60 символов с отметкой — без обрезки: предел без префикса", async () => {
  const { bot, queue } = setup();
  const label = "я".repeat(60);
  const asked = queue.ask(
    new Form({
      places: [],
      steps: [
        {
          head: "❓ Q",
          text: "?",
          options: [{ label }, { label: `${label}ы` }],
          choice: MANY,
          reply: TAKES_TEXT,
        },
      ],
    }),
  );
  await queue.idle();
  expect(bot.calls[0].buttons).toStrictEqual([
    [`☐ ${label}`, `☐ ${"я".repeat(59)}…`],
    ["Готово"],
  ]);
  asked.expire();
  await queue.idle();
});

it("10: текст при пустом ряду и на шаг без своего текста", async () => {
  const { bot, queue } = setup();
  await queue.write("привет");
  expect(bot.calls).toStrictEqual([
    {
      method: "send",
      message: 0,
      text: "сейчас вопросов нет",
      buttons: [],
      data: [],
    },
  ]);
  const asked = queue.ask(
    new Form({
      places: [],
      steps: [{ ...step("🔐 Bash", "ls", ["Yes", "No"]), reply: BUTTONS_ONLY }],
    }),
  );
  await queue.idle();
  await queue.write("нет");
  await queue.idle();
  expect(bot.calls.at(-1)?.text).toBe("ответьте кнопкой");
  asked.expire();
  await queue.idle();
});

it("11: показ отказал — исход «отказ» с причиной, следующий показан", async () => {
  const { bot, queue } = setup();
  bot.fail("send", new BotFailure("401 Unauthorized", 401));
  const first = queue.ask(f1());
  await queue.idle();
  bot.heal("send");
  const second = queue.ask(f2());
  await queue.idle();
  expect((await first.outcome).read(OUTCOME)).toBe(
    "отказ: бот недоступен: 401 Unauthorized",
  );
  expect(bot.calls.map((call) => call.method)).toStrictEqual(["send", "send"]);
  expect(bot.calls[1].text).toBe("🔐 Bash — sl-back\nls");
  second.expire();
  await queue.idle();
});

it("сбой правки исход не меняет — строка в журнал службы", async () => {
  const { bot, log, queue } = setup();
  const asked = queue.ask(f1());
  await queue.idle();
  bot.fail(
    "edit",
    new BotFailure("400 Bad Request: message to edit not found", 400),
  );
  await queue.press("cb", "r1:1:0:0");
  await queue.idle();
  expect((await asked.outcome).read(OUTCOME)).toBe("ответ: вариант 0");
  expect(log).toStrictEqual([
    "telegram: правка сообщения: бот недоступен: 400 Bad Request: message to edit not found",
  ]);
});

it("сбой подтверждения нажатия — строка в журнал, нажатие решает", async () => {
  const { bot, log, queue } = setup();
  const asked = queue.ask(f1());
  await queue.idle();
  bot.fail(
    "ack",
    new BotFailure(
      "400 Bad Request: query is too old and response timeout expired or query ID is invalid",
      400,
    ),
  );
  await queue.press("cb", "r1:1:0:0");
  await queue.idle();
  expect((await asked.outcome).read(OUTCOME)).toBe("ответ: вариант 0");
  expect(log.length).toBe(1);
  expect(log[0].startsWith("telegram: подтверждение нажатия: ")).toBe(true);
});

it("14: длинная подпись — 59 символов и «…», номер варианта тот же", async () => {
  const { bot, queue } = setup();
  const label = "я".repeat(70);
  const asked = queue.ask(
    new Form({
      places: [],
      steps: [step("❓ Q", "?", ["a", label])],
    }),
  );
  await queue.idle();
  expect(bot.calls[0].buttons).toStrictEqual([["a", `${"я".repeat(59)}…`]]);
  await queue.press("cb", "r1:1:0:1");
  await queue.idle();
  expect((await asked.outcome).read(OUTCOME)).toBe("ответ: вариант 1");
  expect(bot.calls.at(-1)?.text).toStrictEqual(
    `❓ Q\n?\n✅ ${label} — из чата`,
  );
});

it("14: длинный текст шага усечён, строки вариантов и «ещё ждут» целы", async () => {
  const { bot, queue } = setup();
  queue.ask(
    new Form({
      places: ["ozon"],
      steps: [
        {
          head: "❓ Q",
          text: "x".repeat(5000),
          options: [{ label: "A", description: "первый" }],
          choice: ONE,
          reply: TAKES_TEXT,
        },
      ],
    }),
  );
  queue.ask(f2());
  await queue.idle();
  const text = bot.calls.at(-1)?.text ?? "";
  expect(text.length).toBe(4096);
  expect(text.startsWith("❓ Q — ozon\nxxx")).toBe(true);
  expect(text.endsWith("…\n• A — первый\nещё ждут: 1")).toBe(true);
});

it("текст, пока следующий вопрос не показан, — не ответ ему", async () => {
  const { bot, queue } = setup();
  queue.ask(f1());
  await queue.idle();
  const second = queue.ask(f2());
  await queue.idle();
  // Ответ на F1 и сразу текст: F2 уже голова ряда, но его сообщения в
  // чате ещё нет — владелец его не видел.
  const pressed = queue.press("cb", "r1:1:0:2");
  const written = queue.write("пояснение");
  await Promise.all([pressed, written]);
  await queue.idle();
  expect(
    bot.calls.filter((call) => call.text === "сейчас вопросов нет").length,
  ).toBe(1);
  second.expire();
  await queue.idle();
  expect((await second.outcome).read(OUTCOME)).toBe("истёк");
});

it("последняя правка не удалась — сообщение помнится до перезапуска", async () => {
  const { bot, memory, queue } = setup();
  const asked = queue.ask(f1());
  await queue.idle();
  bot.fail("edit", new BotFailure("connection refused", 0));
  asked.expire();
  await queue.idle();
  expect(memory.ids()).toStrictEqual([1546]);
});

it("исход в обход очереди правок — старое сообщение теряет кнопки раньше показа нового", async () => {
  const { bot, queue } = setup();
  const first = queue.ask(f1());
  await queue.idle();
  // Второй вопрос ставит перерисовку, и исход первого приходит, пока она
  // ещё в цепочке.
  queue.ask(f2());
  first.withdraw("решено в терминале");
  await queue.idle();
  expect(bot.calls.map((call) => [call.method, call.message])).toStrictEqual([
    ["send", 0],
    ["edit", 1546],
    ["send", 0],
  ]);
  expect(bot.calls[1].buttons).toStrictEqual([]);
});

/**
 * Форма «ждёт ввода» сессии `name` (`platform/telegram-questions.md`,
 * «R2»): шаг без вариантов, кнопки `Позже` и `Пропустить`.
 */
function waits(name: string): Form {
  return new Form({
    places: [],
    kind: WAITS_INPUT,
    steps: [
      {
        head: `💬 ${name}`,
        text: `${name} ждёт`,
        options: [],
        choice: ONE,
        reply: BUTTONS_ONLY,
      },
    ],
    actions: [LATER, SKIP],
  });
}

/** Сообщение «ждёт ввода» сессии `name` вопроса `number` с кнопками. */
function waitsSent(name: string, number: number, tail: string[] = []): Call {
  return {
    method: "send",
    message: 0,
    text: [`💬 ${name}`, `${name} ждёт`, ...tail].join("\n"),
    buttons: [["Позже", "Пропустить"]],
    data: [[`r1:${number}:0:later`, `r1:${number}:0:skip`]],
  };
}

/** Правка без кнопок: последняя строка `line`. */
function closed(message: number, text: string, line: string): Call {
  return {
    method: "edit",
    message,
    text: `${text}\n${line}`,
    buttons: [],
    data: [],
  };
}

const ACK: Call = {
  method: "ack",
  message: 0,
  text: "",
  buttons: [],
  data: [],
};

it("R2a-4: срочный вытесняет «ждёт ввода»: кнопки сняты, срочный — новым, затем «ждёт» — снова новым", async () => {
  const { bot, memory, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  expect(bot.calls).toStrictEqual([waitsSent("A", 1)]);
  queue.ask(f1());
  await queue.idle();
  expect(since(bot, 1)).toStrictEqual([
    closed(1546, "💬 A\nA ждёт", "↷ ждёт после срочного"),
    {
      method: "send",
      message: 0,
      text: `${F1_TEXT}\nещё ждут: 1`,
      buttons: F1_BUTTONS,
      data: [["r1:2:0:0", "r1:2:0:1"], ["r1:2:0:2"]],
    },
  ]);
  // Ровно одно сообщение с кнопками помнится до перезапуска.
  expect(memory.ids()).toStrictEqual([1547]);
  await queue.press("cb", "r1:2:0:0");
  await queue.idle();
  expect(since(bot, 3)).toStrictEqual([
    ACK,
    closed(1547, F1_TEXT, "✅ Yes — из чата"),
    waitsSent("A", 1),
  ]);
  // У нового сообщения A данные кнопок прежние: номер и шаг те же.
  await queue.press("cb2", "r1:1:0:skip");
  await queue.idle();
  expect((await a.outcome).read(OUTCOME)).toBe("снят");
});

it("R2a-5: срочные по времени, затем «ждёт ввода» по времени", async () => {
  const { bot, queue } = setup();
  const b = queue.ask(f1());
  const a = queue.ask(waits("A"));
  const e = queue.ask(f2());
  const d = queue.ask(waits("D"));
  await queue.idle();
  expect(bot.calls.at(-1)?.text).toStrictEqual(`${F1_TEXT}\nещё ждут: 3`);
  b.expire();
  await queue.idle();
  expect(bot.calls.at(-1)?.text.split("\n")[0]).toBe("🔐 Bash — sl-back");
  e.expire();
  await queue.idle();
  expect(bot.calls.at(-1)).toStrictEqual(waitsSent("A", 2, ["ещё ждут: 1"]));
  a.withdraw("решено в терминале");
  await queue.idle();
  expect(bot.calls.at(-1)).toStrictEqual(waitsSent("D", 4));
  d.expire();
  await queue.idle();
});

it("R2a-6: «Позже» — в конец своего вида, следующий — новым; один — подсказка", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  await queue.press("cb1", "r1:1:0:later");
  await queue.idle();
  expect(since(bot, 1)).toStrictEqual([
    {
      method: "ack",
      message: 0,
      text: "больше ничего не ждёт",
      buttons: [],
      data: [],
    },
  ]);
  const d = queue.ask(waits("D"));
  await queue.idle();
  const from = bot.calls.length;
  await queue.press("cb2", "r1:1:0:later");
  await queue.idle();
  expect(since(bot, from)).toStrictEqual([
    ACK,
    closed(1546, "💬 A\nA ждёт", "↷ отложено"),
    waitsSent("D", 2, ["ещё ждут: 1"]),
  ]);
  d.withdraw("решено в терминале");
  await queue.idle();
  expect(bot.calls.at(-2)).toStrictEqual(
    closed(1547, "💬 D\nD ждёт", "✅ решено в терминале"),
  );
  expect(bot.calls.at(-1)).toStrictEqual(waitsSent("A", 1));
  a.expire();
  await queue.idle();
});

it("R2a-7: «Пропустить» — исход «снят», строка «⏭ пропущено», кнопок нет", async () => {
  const { bot, memory, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  await queue.press("cb", "r1:1:0:skip");
  await queue.idle();
  expect(since(bot, 1)).toStrictEqual([
    ACK,
    closed(1546, "💬 A\nA ждёт", "⏭ пропущено"),
  ]);
  expect((await a.outcome).read(OUTCOME)).toBe("снят");
  expect(memory.ids()).toStrictEqual([]);
});

it("отложенный и снятый — правится его прежнее сообщение, нового нет", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  const b = queue.ask(f1());
  await queue.idle();
  a.withdraw("решено в терминале");
  await queue.idle();
  expect(bot.calls.at(-2)).toStrictEqual(
    closed(1546, "💬 A\nA ждёт", "✅ решено в терминале"),
  );
  expect(bot.calls.at(-1)?.text).toStrictEqual(F1_TEXT);
  b.expire();
  await queue.idle();
  expect(bot.calls.filter((call) => call.method === "send").length).toBe(2);
});

it("текст на «ждёт ввода» без своего текста — подсказка шага", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  await queue.write("синий");
  await queue.idle();
  expect(bot.calls.at(-1)?.text).toBe("ответьте кнопкой");
  a.expire();
  await queue.idle();
});

it("placed: решается после первой перерисовки; отказ показа — раньше", async () => {
  const { bot, queue } = setup();
  const order: string[] = [];
  bot.fail("send", new BotFailure("403 Forbidden", 403));
  const refused = queue.ask(waits("A"));
  await Promise.all([
    refused.outcome.then((outcome) => order.push(outcome.read(OUTCOME))),
    refused.placed.then(() => order.push("поставлен")),
  ]);
  expect(order).toStrictEqual([
    "отказ: бот недоступен: 403 Forbidden",
    "поставлен",
  ]);
  bot.heal("send");
  const from = bot.calls.length;
  const b = queue.ask(f1());
  const behind = queue.ask(waits("D"));
  await behind.placed;
  // Стоит за срочным: показан не был, но поставлен.
  expect(since(bot, from).filter((call) => call.method === "send").length).toBe(
    1,
  );
  b.expire();
  behind.expire();
  await queue.idle();
});

it("уступил и тут же снят — последней правкой остаётся строка исхода", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  const b = queue.ask(f1());
  a.withdraw("решено в терминале");
  await queue.idle();
  const edits = bot.calls.filter(
    (call) => call.method === "edit" && call.message === 1546,
  );
  expect(edits.at(-1)).toStrictEqual(
    closed(1546, "💬 A\nA ждёт", "✅ решено в терминале"),
  );
  b.expire();
  await queue.idle();
});

it("срочный снят раньше показа — показанный «ждёт» не тронут, дубля нет", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  const b = queue.ask(f1());
  b.expire();
  await queue.idle();
  expect(bot.calls).toStrictEqual([waitsSent("A", 1)]);
  a.expire();
  await queue.idle();
});

it("кнопки-действия, которых форма не предлагала, — «вопрос уже решён»", async () => {
  const { bot, queue } = setup();
  const asked = queue.ask(f1());
  queue.ask(f2());
  await queue.idle();
  await queue.press("cb1", "r1:1:0:skip");
  await queue.press("cb2", "r1:1:0:later");
  await queue.idle();
  expect(since(bot, 1).map((call) => [call.method, call.text])).toStrictEqual([
    ["ack", "вопрос уже решён"],
    ["ack", "вопрос уже решён"],
  ]);
  asked.expire();
  await queue.idle();
});

it("голова решена, пока шла правка, — её кнопки сняты раньше показа следующей", async () => {
  const { bot, queue } = setup();
  const w1 = queue.ask(waits("W1"));
  await queue.idle();
  const u2 = queue.ask(f1());
  await queue.idle();
  // Сеть медленная: снятие отложенного W1 — правка без ответа.
  const release = bot.holdEdits();
  const from = bot.calls.length;
  w1.withdraw("решено в терминале");
  await bot.called(from + 1);
  // Пока правка идёт, активный U2 решён и пришёл W3.
  u2.expire();
  const w3 = queue.ask(waits("W3"));
  release();
  await queue.idle();
  expect(bot.twoWithButtons()).toBe("");
  // Показ шёл: W3 — новым сообщением с кнопками, единственным в чате.
  expect(bot.calls.at(-1)?.text).toBe("💬 W3\nW3 ждёт");
  expect(bot.buttonedNow()).toBe(1);
  w3.expire();
  await queue.idle();
});

/** Ход-генератор с семенем: последовательность воспроизводима. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/**
 * Правило текста с доставкой (как у сессии с каналом): ответ приходит
 * через несколько микрозадач — доставлено (шаг отвечен) или отказ
 * (подсказка владельцу, вопрос активен).
 */
function delivering(next: () => number): TextRule {
  return {
    write: (text, events) => ({
      deliver: async (say) => {
        const turns = Math.floor(next() * 4);
        for (let turn = 0; turn < turns; turn++) await Promise.resolve();
        if (next() < 0.5) {
          events.answered(new Written(text));
          return;
        }
        await say("не доставлено: сессия без канала");
      },
    }),
  };
}

/**
 * Живой вопрос (как снимок окна): текст — свойством, перерисовка — по
 * `changed()` слушателя, полученного нажатием; `redraw` зовёт её в любой
 * момент, в том числе после исхода.
 */
function live(name: string) {
  let text = `${name}: 1`;
  let events: StepEvents = {
    answered: () => {},
    closed: () => {},
    changed: () => {},
  };
  const form = new Form({
    places: [],
    steps: [
      {
        head: `🖥 ${name}`,
        get text() {
          return text;
        },
        options: [{ label: "1" }],
        choice: {
          start: () => ({
            press: (given) => {
              events = given;
              return { pick: () => "", done: () => STALE };
            },
            buttons: () => [[{ label: "1", key: new OptionKey(0) }]],
          }),
        },
        reply: BUTTONS_ONLY,
      },
    ],
  });
  return {
    form,
    redraw: (turn: number) => {
      text = `${name}: ${turn}`;
      events.changed();
    },
  };
}

/** «Ждёт ввода» сессии с каналом: свой текст — доставка. */
function waitsWithChannel(name: string, reply: TextRule): Form {
  return new Form({
    places: [],
    kind: WAITS_INPUT,
    steps: [
      {
        head: `💬 ${name}`,
        text: name,
        options: [],
        choice: ONE,
        reply,
      },
    ],
    actions: [LATER, SKIP],
  });
}

it("свойство: при любых приходах, исходах, доставках, медленных правках и очерёдности микрозадач кнопки — у одного сообщения", async () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = seeded(seed);
    const { bot, queue } = setup();
    const asked: Asked[] = [];
    const steps: string[] = [];
    const writes: Promise<void>[] = [];
    const lives: ReturnType<typeof live>[] = [];
    let release = () => {};
    for (let step = 0; step < 18; step++) {
      const roll = next();
      const pick = () => Math.floor(next() * asked.length);
      if (roll < 0.12) {
        asked.push(queue.ask(f1()));
        steps.push(`срочный ${asked.length}`);
      } else if (roll < 0.18) {
        // Форма, которую вариант кончает досрочно (`oneClosing`).
        asked.push(queue.ask(closingForm()));
        steps.push(`кончающий ${asked.length}`);
      } else if (roll < 0.32) {
        asked.push(queue.ask(waits(`W${asked.length + 1}`)));
        steps.push(`ждёт ${asked.length}`);
      } else if (roll < 0.4) {
        asked.push(
          queue.ask(waitsWithChannel(`C${asked.length + 1}`, delivering(next))),
        );
        steps.push(`ждёт с каналом ${asked.length}`);
      } else if (roll < 0.43) {
        const one = live(`L${asked.length + 1}`);
        lives.push(one);
        asked.push(queue.ask(one.form));
        steps.push(`живой ${asked.length}`);
      } else if (roll < 0.45 && lives.length > 0) {
        lives[Math.floor(next() * lives.length)].redraw(step);
        steps.push("живой перерисован");
      } else if (roll < 0.47) {
        writes.push(queue.write("Синий"));
        steps.push("текст");
      } else if (roll < 0.49 && asked.length > 0) {
        const k = pick();
        asked[k].withdrawAs("⌛ сессия закрыта");
        steps.push(`закрыта ${k + 1}`);
      } else if (roll < 0.56 && asked.length > 0) {
        const k = pick();
        asked[k].withdraw("решено в терминале");
        steps.push(`снят ${k + 1}`);
      } else if (roll < 0.62 && asked.length > 0) {
        const k = pick();
        asked[k].expire();
        steps.push(`истёк ${k + 1}`);
      } else if (roll < 0.72 && asked.length > 0) {
        const k = pick() + 1;
        const key = ["later", "0", "2"][Math.floor(next() * 3)];
        await queue.press("c", `r1:${k}:0:${key}`);
        steps.push(`нажат ${k}`);
      } else if (roll < 0.8) {
        release = bot.holdEdits();
        steps.push("правки ждут");
      } else if (roll < 0.85) {
        release();
        steps.push("правки идут");
      } else if (roll < 0.93) {
        // Цепочка правок идёт между микрозадачами: исход, пришедший в
        // любую из них, — свой порядок событий.
        const turns = Math.floor(next() * 6);
        for (let turn = 0; turn < turns; turn++) await Promise.resolve();
        steps.push(`уступить ${turns}`);
      } else {
        release();
        await queue.idle();
        steps.push("тишина");
      }
    }
    release();
    await Promise.all(writes);
    for (const one of asked) one.expire();
    await queue.idle();
    const trace = `семя ${seed}: ${steps.join(", ")}`;
    expect(bot.twoWithButtons(), trace).toBe("");
    // Все исходы пришли — кнопок не осталось ни у кого.
    expect(bot.buttonedNow(), trace).toBe(0);
  }
});

it("сбой сети при уступлении — прежнее сообщение остаётся своим: снова активный правит его, второго нет", async () => {
  const { bot, log, queue } = setup();
  const w1 = queue.ask(waits("W1"));
  await queue.idle();
  bot.fail("edit", new BotFailure("сеть недоступна", 0));
  const u2 = queue.ask(f1());
  await queue.idle();
  bot.heal("edit");
  u2.expire();
  await queue.idle();
  // W1 снова активен своим первым сообщением (1546): кнопки на нём так и
  // не снимались, второго сообщения W1 нет.
  expect(bot.calls.filter((call) => call.method === "send").length).toBe(2);
  expect(bot.calls.at(-1)).toStrictEqual({
    method: "edit",
    message: 1547,
    text: `${F1_TEXT}\n⌛ истёк — ответьте в терминале`,
    buttons: [],
    data: [],
  });
  expect(bot.buttonedNow()).toBe(1);
  expect(log).toStrictEqual([
    "telegram: правка сообщения: бот недоступен: сеть недоступна",
  ]);
  w1.expire();
  await queue.idle();
});

it("withdrawAs — последняя строка целиком, для потребителя — снят", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  a.withdrawAs("⌛ сессия закрыта");
  await queue.idle();
  expect(bot.calls.at(-1)).toStrictEqual(
    closed(1546, "💬 A\nA ждёт", "⌛ сессия закрыта"),
  );
  expect((await a.outcome).read(OUTCOME)).toBe("снят");
});

it("R4: живой текст шага перечитывается при перерисовке — правка того же сообщения", async () => {
  const { bot, queue } = setup();
  let screen = "Экран 1";
  let events: { changed(): void } = { changed: () => {} };
  const live = {
    head: "🖥 probe",
    get text() {
      return screen;
    },
    options: [{ label: "1. Yes" }],
    choice: {
      start: () => ({
        press: (stepEvents: { changed(): void }) => {
          events = stepEvents;
          return { pick: () => "", done: () => "" };
        },
        buttons: () => [],
      }),
    },
    reply: BUTTONS_ONLY,
  };
  const asked = queue.ask(new Form({ places: [], steps: [live] }));
  await queue.idle();
  await queue.press("cb", "r1:1:0:0");
  screen = "Экран 2";
  events.changed();
  await queue.idle();
  expect(bot.calls.at(-1)?.method).toBe("edit");
  expect(bot.calls.at(-1)?.message).toBe(1546);
  expect(bot.calls.at(-1)?.text).toBe("🖥 probe\nЭкран 2");
  asked.expire();
  await queue.idle();
});
