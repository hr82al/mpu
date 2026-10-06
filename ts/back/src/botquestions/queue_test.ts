/**
 * Ряд вопросов и сообщение с кнопками
 * (`docs/specs/platform/telegram-questions.md`; сценарии постановки R1a —
 * номерами в именах тестов). Чат — фейк Bot API, вызовы сверяются по
 * порядку.
 */

import { assertEquals } from "@std/assert";
import { BotFailure } from "./bot_api.ts";
import {
  BUTTONS_ONLY,
  Form,
  LATER,
  MANY,
  ONE,
  SKIP,
  TAKES_TEXT,
} from "./form.ts";
import { WAITS_INPUT } from "./row.ts";
import type { OutcomeReader, StepAnswerReader } from "./outcome.ts";
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

Deno.test("1: вопрос в пустом ряду — одно сообщение с кнопками по две", async () => {
  const { bot, memory, queue } = setup();
  queue.ask(f1());
  await queue.idle();
  assertEquals(bot.calls, [{
    method: "send",
    message: 0,
    text: F1_TEXT,
    buttons: F1_BUTTONS,
    data: [["r1:1:0:0", "r1:1:0:1"], ["r1:1:0:2"]],
  }]);
  assertEquals(memory.ids(), [1546]);
});

Deno.test("2: нажатие — подтверждение первым, исход, правка без кнопок", async () => {
  const { bot, memory, queue } = setup();
  const asked = queue.ask(f1());
  await queue.idle();
  await queue.press("cb1", "r1:1:0:0");
  await queue.idle();
  assertEquals(since(bot, 1), [
    { method: "ack", message: 0, text: "", buttons: [], data: [] },
    {
      method: "edit",
      message: 1546,
      text: `${F1_TEXT}\n✅ Yes — из чата`,
      buttons: [],
      data: [],
    },
  ]);
  assertEquals((await asked.outcome).read(OUTCOME), "ответ: вариант 0");
  assertEquals(memory.ids(), []);
});

Deno.test("3: текст владельца — ответ шага, строка исхода — потребителя", async () => {
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
  assertEquals(
    (await asked.outcome).read(OUTCOME),
    "ответ: текст не трогай /tmp",
  );
  assertEquals(
    bot.calls.at(-1)?.text,
    `${F1_TEXT}\n❌ No: не трогай /tmp — из чата`,
  );
});

Deno.test("5: повтор нажатия и кнопка прошлого запуска — «вопрос уже решён»", async () => {
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
  assertEquals(bot.calls[1].text, "вопрос уже решён");
  assertEquals(since(bot, before).map((call) => [call.method, call.text]), [
    ["ack", "вопрос уже решён"],
    ["ack", "вопрос уже решён"],
  ]);
  assertEquals((await asked.outcome).read(OUTCOME), "ответ: вариант 2");
});

Deno.test("6: второй вопрос — «ещё ждут: 1» правкой с кнопками, после исхода — новым сообщением", async () => {
  const { bot, queue } = setup();
  queue.ask(f1());
  await queue.idle();
  queue.ask(f2());
  await queue.idle();
  assertEquals(bot.calls.map((call) => call.method), ["send", "edit"]);
  assertEquals(bot.calls[1].text, `${F1_TEXT}\nещё ждут: 1`);
  // Правка счётчика без кнопок сняла бы их: Bot API без `reply_markup`
  // убирает клавиатуру.
  assertEquals(bot.calls[1].buttons, F1_BUTTONS);
  await queue.press("cb1", "r1:1:0:0");
  await queue.idle();
  assertEquals(since(bot, 2).map((call) => [call.method, call.message]), [
    ["ack", 0],
    ["edit", 1546],
    ["send", 0],
  ]);
  assertEquals(bot.calls[3].text, `${F1_TEXT}\n✅ Yes — из чата`);
  assertEquals(bot.calls[4].text, "🔐 Bash — sl-back\nls");
  assertEquals(bot.calls[4].data, [["r1:2:0:0", "r1:2:0:1"]]);
});

Deno.test("7: ожидающий снят до показа — строка «ещё ждут» убрана, нового сообщения нет", async () => {
  const { bot, queue } = setup();
  queue.ask(f1());
  const second = queue.ask(f2());
  await queue.idle();
  second.withdraw("решено в терминале");
  await queue.idle();
  assertEquals((await second.outcome).read(OUTCOME), "снят");
  assertEquals(bot.calls.at(-1), {
    method: "edit",
    message: 1546,
    text: F1_TEXT,
    buttons: F1_BUTTONS,
    data: [["r1:1:0:0", "r1:1:0:1"], ["r1:1:0:2"]],
  });
  const before = bot.calls.length;
  await queue.press("cb1", "r1:1:0:0");
  await queue.idle();
  assertEquals(since(bot, before).map((call) => call.method), ["ack", "edit"]);
});

Deno.test("снят показанный — правка строкой снятия; истёк — строкой истечения", async () => {
  const { bot, queue } = setup();
  const first = queue.ask(f1());
  await queue.idle();
  first.withdraw("решено в терминале");
  await queue.idle();
  assertEquals(bot.calls.at(-1)?.text, `${F1_TEXT}\n✅ решено в терминале`);
  const second = queue.ask(f1());
  await queue.idle();
  second.expire();
  await queue.idle();
  assertEquals(
    bot.calls.at(-1)?.text,
    `${F1_TEXT}\n⌛ истёк — ответьте в терминале`,
  );
  assertEquals((await second.outcome).read(OUTCOME), "истёк");
  // Второй исход ничего не меняет: исход у вопроса один.
  const before = bot.calls.length;
  second.withdraw("решено в терминале");
  await queue.idle();
  assertEquals(bot.calls.length, before);
});

/** Форма с шагом «несколько» `S`, `M`. */
function sizes(): Form {
  return new Form({
    places: ["ozon"],
    steps: [{
      head: "❓ Размер",
      text: "Какой размер?",
      options: [{ label: "S" }, { label: "M" }],
      choice: MANY,
      reply: TAKES_TEXT,
    }],
  });
}

Deno.test("8: несколько — отметки правкой, «Готово» без отметок — подсказка", async () => {
  const { bot, queue } = setup();
  const asked = queue.ask(sizes());
  await queue.idle();
  assertEquals(bot.calls[0].buttons, [["☐ S", "☐ M"], ["Готово"]]);
  await queue.press("a", "r1:1:0:ok");
  await queue.idle();
  assertEquals(bot.calls.at(-1)?.text, "отметьте хотя бы один вариант");
  await queue.press("b", "r1:1:0:0");
  await queue.idle();
  assertEquals(bot.calls.at(-1)?.buttons, [["☑ S", "☐ M"], ["Готово"]]);
  await queue.press("c", "r1:1:0:1");
  await queue.press("d", "r1:1:0:ok");
  await queue.idle();
  assertEquals((await asked.outcome).read(OUTCOME), "ответ: вариант 0,1");
  assertEquals(
    bot.calls.at(-1)?.text,
    "❓ Размер — ozon\nКакой размер?\n✅ S, M — из чата",
  );
});

Deno.test("9: два шага — то же сообщение правится на шаг 2, исход один, после последнего", async () => {
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
  assertEquals(
    bot.calls[0].text,
    "❓ Цвет 1/2 — ozon\nКакой цвет?\n• Красный — Красный цвет\n• Синий — Синий цвет",
  );
  await queue.press("a", "r1:1:0:1");
  await queue.idle();
  assertEquals(settled, false);
  assertEquals(bot.calls.at(-1), {
    method: "edit",
    message: 1546,
    text: "❓ Цвет 2/2 — ozon\nКакой размер?",
    buttons: [["S", "M"]],
    data: [["r1:1:1:0", "r1:1:1:1"]],
  });
  // Повтор нажатия шага 1 шагу 2 не отвечает.
  await queue.press("a", "r1:1:0:1");
  await queue.idle();
  assertEquals(bot.calls.at(-1)?.text, "вопрос уже решён");
  assertEquals(settled, false);
  await queue.press("b", "r1:1:1:0");
  await watched;
  assertEquals(
    (await asked.outcome).read(OUTCOME),
    "ответ: вариант 1; вариант 0",
  );
  await queue.idle();
  // Строка ответа многошагового — ответы шагов через `; ` («Уточнения R1a»).
  assertEquals(
    bot.calls.at(-1)?.text,
    "❓ Цвет 2/2 — ozon\nКакой размер?\n✅ Синий; S — из чата",
  );
  assertEquals(bot.calls.filter((call) => call.method === "send").length, 1);
});

Deno.test("подпись в 60 символов с отметкой — без обрезки: предел без префикса", async () => {
  const { bot, queue } = setup();
  const label = "я".repeat(60);
  const asked = queue.ask(
    new Form({
      places: [],
      steps: [{
        head: "❓ Q",
        text: "?",
        options: [{ label }, { label: `${label}ы` }],
        choice: MANY,
        reply: TAKES_TEXT,
      }],
    }),
  );
  await queue.idle();
  assertEquals(bot.calls[0].buttons, [
    [`☐ ${label}`, `☐ ${"я".repeat(59)}…`],
    ["Готово"],
  ]);
  asked.expire();
  await queue.idle();
});

Deno.test("10: текст при пустом ряду и на шаг без своего текста", async () => {
  const { bot, queue } = setup();
  await queue.write("привет");
  assertEquals(bot.calls, [
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
  assertEquals(bot.calls.at(-1)?.text, "ответьте кнопкой");
  asked.expire();
  await queue.idle();
});

Deno.test("11: показ отказал — исход «отказ» с причиной, следующий показан", async () => {
  const { bot, queue } = setup();
  bot.fail("send", new BotFailure("401 Unauthorized", 401));
  const first = queue.ask(f1());
  await queue.idle();
  bot.heal("send");
  const second = queue.ask(f2());
  await queue.idle();
  assertEquals(
    (await first.outcome).read(OUTCOME),
    "отказ: бот недоступен: 401 Unauthorized",
  );
  assertEquals(bot.calls.map((call) => call.method), ["send", "send"]);
  assertEquals(bot.calls[1].text, "🔐 Bash — sl-back\nls");
  second.expire();
  await queue.idle();
});

Deno.test("сбой правки исход не меняет — строка в журнал службы", async () => {
  const { bot, log, queue } = setup();
  const asked = queue.ask(f1());
  await queue.idle();
  bot.fail(
    "edit",
    new BotFailure("400 Bad Request: message to edit not found", 400),
  );
  await queue.press("cb", "r1:1:0:0");
  await queue.idle();
  assertEquals((await asked.outcome).read(OUTCOME), "ответ: вариант 0");
  assertEquals(log, [
    "telegram: правка сообщения: бот недоступен: 400 Bad Request: message to edit not found",
  ]);
});

Deno.test("сбой подтверждения нажатия — строка в журнал, нажатие решает", async () => {
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
  assertEquals((await asked.outcome).read(OUTCOME), "ответ: вариант 0");
  assertEquals(log.length, 1);
  assertEquals(log[0].startsWith("telegram: подтверждение нажатия: "), true);
});

Deno.test("14: длинная подпись — 59 символов и «…», номер варианта тот же", async () => {
  const { bot, queue } = setup();
  const label = "я".repeat(70);
  const asked = queue.ask(
    new Form({
      places: [],
      steps: [step("❓ Q", "?", ["a", label])],
    }),
  );
  await queue.idle();
  assertEquals(bot.calls[0].buttons, [["a", `${"я".repeat(59)}…`]]);
  await queue.press("cb", "r1:1:0:1");
  await queue.idle();
  assertEquals((await asked.outcome).read(OUTCOME), "ответ: вариант 1");
  assertEquals(bot.calls.at(-1)?.text, `❓ Q\n?\n✅ ${label} — из чата`);
});

Deno.test("14: длинный текст шага усечён, строки вариантов и «ещё ждут» целы", async () => {
  const { bot, queue } = setup();
  queue.ask(
    new Form({
      places: ["ozon"],
      steps: [{
        head: "❓ Q",
        text: "x".repeat(5000),
        options: [{ label: "A", description: "первый" }],
        choice: ONE,
        reply: TAKES_TEXT,
      }],
    }),
  );
  queue.ask(f2());
  await queue.idle();
  const text = bot.calls.at(-1)?.text ?? "";
  assertEquals(text.length, 4096);
  assertEquals(text.startsWith("❓ Q — ozon\nxxx"), true);
  assertEquals(text.endsWith("…\n• A — первый\nещё ждут: 1"), true);
});

Deno.test("текст, пока следующий вопрос не показан, — не ответ ему", async () => {
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
  assertEquals(
    bot.calls.filter((call) => call.text === "сейчас вопросов нет").length,
    1,
  );
  second.expire();
  await queue.idle();
  assertEquals(
    (await second.outcome).read(OUTCOME),
    "истёк",
  );
});

Deno.test("последняя правка не удалась — сообщение помнится до перезапуска", async () => {
  const { bot, memory, queue } = setup();
  const asked = queue.ask(f1());
  await queue.idle();
  bot.fail("edit", new BotFailure("connection refused", 0));
  asked.expire();
  await queue.idle();
  assertEquals(memory.ids(), [1546]);
});

Deno.test("исход в обход очереди правок — старое сообщение теряет кнопки раньше показа нового", async () => {
  const { bot, queue } = setup();
  const first = queue.ask(f1());
  await queue.idle();
  // Второй вопрос ставит перерисовку, и исход первого приходит, пока она
  // ещё в цепочке.
  queue.ask(f2());
  first.withdraw("решено в терминале");
  await queue.idle();
  assertEquals(bot.calls.map((call) => [call.method, call.message]), [
    ["send", 0],
    ["edit", 1546],
    ["send", 0],
  ]);
  assertEquals(bot.calls[1].buttons, []);
});

/**
 * Форма «ждёт ввода» сессии `name` (`platform/telegram-questions.md`,
 * «R2»): шаг без вариантов, кнопки `Позже` и `Пропустить`.
 */
function waits(name: string): Form {
  return new Form({
    places: [],
    kind: WAITS_INPUT,
    steps: [{
      head: `💬 ${name}`,
      text: `${name} ждёт`,
      options: [],
      choice: ONE,
      reply: BUTTONS_ONLY,
    }],
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

Deno.test("R2a-4: срочный вытесняет «ждёт ввода»: кнопки сняты, срочный — новым, затем «ждёт» — снова новым", async () => {
  const { bot, memory, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  assertEquals(bot.calls, [waitsSent("A", 1)]);
  queue.ask(f1());
  await queue.idle();
  assertEquals(since(bot, 1), [
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
  assertEquals(memory.ids(), [1547]);
  await queue.press("cb", "r1:2:0:0");
  await queue.idle();
  assertEquals(since(bot, 3), [
    ACK,
    closed(1547, F1_TEXT, "✅ Yes — из чата"),
    waitsSent("A", 1),
  ]);
  // У нового сообщения A данные кнопок прежние: номер и шаг те же.
  await queue.press("cb2", "r1:1:0:skip");
  await queue.idle();
  assertEquals((await a.outcome).read(OUTCOME), "снят");
});

Deno.test("R2a-5: срочные по времени, затем «ждёт ввода» по времени", async () => {
  const { bot, queue } = setup();
  const b = queue.ask(f1());
  const a = queue.ask(waits("A"));
  const e = queue.ask(f2());
  const d = queue.ask(waits("D"));
  await queue.idle();
  assertEquals(bot.calls.at(-1)?.text, `${F1_TEXT}\nещё ждут: 3`);
  b.expire();
  await queue.idle();
  assertEquals(bot.calls.at(-1)?.text.split("\n")[0], "🔐 Bash — sl-back");
  e.expire();
  await queue.idle();
  assertEquals(bot.calls.at(-1), waitsSent("A", 2, ["ещё ждут: 1"]));
  a.withdraw("решено в терминале");
  await queue.idle();
  assertEquals(bot.calls.at(-1), waitsSent("D", 4));
  d.expire();
  await queue.idle();
});

Deno.test("R2a-6: «Позже» — в конец своего вида, следующий — новым; один — подсказка", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  await queue.press("cb1", "r1:1:0:later");
  await queue.idle();
  assertEquals(since(bot, 1), [{
    method: "ack",
    message: 0,
    text: "больше ничего не ждёт",
    buttons: [],
    data: [],
  }]);
  const d = queue.ask(waits("D"));
  await queue.idle();
  const from = bot.calls.length;
  await queue.press("cb2", "r1:1:0:later");
  await queue.idle();
  assertEquals(since(bot, from), [
    ACK,
    closed(1546, "💬 A\nA ждёт", "↷ отложено"),
    waitsSent("D", 2, ["ещё ждут: 1"]),
  ]);
  d.withdraw("решено в терминале");
  await queue.idle();
  assertEquals(
    bot.calls.at(-2),
    closed(1547, "💬 D\nD ждёт", "✅ решено в терминале"),
  );
  assertEquals(bot.calls.at(-1), waitsSent("A", 1));
  a.expire();
  await queue.idle();
});

Deno.test("R2a-7: «Пропустить» — исход «снят», строка «⏭ пропущено», кнопок нет", async () => {
  const { bot, memory, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  await queue.press("cb", "r1:1:0:skip");
  await queue.idle();
  assertEquals(since(bot, 1), [
    ACK,
    closed(1546, "💬 A\nA ждёт", "⏭ пропущено"),
  ]);
  assertEquals((await a.outcome).read(OUTCOME), "снят");
  assertEquals(memory.ids(), []);
});

Deno.test("отложенный и снятый — правится его прежнее сообщение, нового нет", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  const b = queue.ask(f1());
  await queue.idle();
  a.withdraw("решено в терминале");
  await queue.idle();
  assertEquals(
    bot.calls.at(-2),
    closed(1546, "💬 A\nA ждёт", "✅ решено в терминале"),
  );
  assertEquals(bot.calls.at(-1)?.text, F1_TEXT);
  b.expire();
  await queue.idle();
  assertEquals(
    bot.calls.filter((call) => call.method === "send").length,
    2,
  );
});

Deno.test("текст на «ждёт ввода» без своего текста — подсказка шага", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  await queue.write("синий");
  await queue.idle();
  assertEquals(bot.calls.at(-1)?.text, "ответьте кнопкой");
  a.expire();
  await queue.idle();
});

Deno.test("placed: решается после первой перерисовки; отказ показа — раньше", async () => {
  const { bot, queue } = setup();
  const order: string[] = [];
  bot.fail("send", new BotFailure("403 Forbidden", 403));
  const refused = queue.ask(waits("A"));
  await Promise.all([
    refused.outcome.then((outcome) => order.push(outcome.read(OUTCOME))),
    refused.placed.then(() => order.push("поставлен")),
  ]);
  assertEquals(order, ["отказ: бот недоступен: 403 Forbidden", "поставлен"]);
  bot.heal("send");
  const from = bot.calls.length;
  const b = queue.ask(f1());
  const behind = queue.ask(waits("D"));
  await behind.placed;
  // Стоит за срочным: показан не был, но поставлен.
  assertEquals(
    since(bot, from).filter((call) => call.method === "send").length,
    1,
  );
  b.expire();
  behind.expire();
  await queue.idle();
});

Deno.test("уступил и тут же снят — последней правкой остаётся строка исхода", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  const b = queue.ask(f1());
  a.withdraw("решено в терминале");
  await queue.idle();
  const edits = bot.calls.filter((call) =>
    call.method === "edit" && call.message === 1546
  );
  assertEquals(
    edits.at(-1),
    closed(1546, "💬 A\nA ждёт", "✅ решено в терминале"),
  );
  b.expire();
  await queue.idle();
});

Deno.test("срочный снят раньше показа — показанный «ждёт» не тронут, дубля нет", async () => {
  const { bot, queue } = setup();
  const a = queue.ask(waits("A"));
  await queue.idle();
  const b = queue.ask(f1());
  b.expire();
  await queue.idle();
  assertEquals(bot.calls, [waitsSent("A", 1)]);
  a.expire();
  await queue.idle();
});

Deno.test("кнопки-действия, которых форма не предлагала, — «вопрос уже решён»", async () => {
  const { bot, queue } = setup();
  const asked = queue.ask(f1());
  queue.ask(f2());
  await queue.idle();
  await queue.press("cb1", "r1:1:0:skip");
  await queue.press("cb2", "r1:1:0:later");
  await queue.idle();
  assertEquals(
    since(bot, 1).map((call) => [call.method, call.text]),
    [["ack", "вопрос уже решён"], ["ack", "вопрос уже решён"]],
  );
  asked.expire();
  await queue.idle();
});

Deno.test("голова решена, пока шла правка, — её кнопки сняты раньше показа следующей", async () => {
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
  assertEquals(bot.twoWithButtons(), "");
  // Показ шёл: W3 — новым сообщением с кнопками, единственным в чате.
  assertEquals(bot.calls.at(-1)?.text, "💬 W3\nW3 ждёт");
  assertEquals(bot.buttonedNow(), 1);
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

Deno.test("свойство: при любых приходах, исходах, медленных правках и очерёдности микрозадач кнопки — у одного сообщения", async () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = seeded(seed);
    const { bot, queue } = setup();
    const asked: Asked[] = [];
    const steps: string[] = [];
    let release = () => {};
    for (let step = 0; step < 16; step++) {
      const roll = next();
      const pick = () => Math.floor(next() * asked.length);
      if (roll < 0.22) {
        asked.push(queue.ask(f1()));
        steps.push(`срочный ${asked.length}`);
      } else if (roll < 0.44) {
        asked.push(queue.ask(waits(`W${asked.length + 1}`)));
        steps.push(`ждёт ${asked.length}`);
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
        await queue.press("c", `r1:${k}:0:${next() < 0.5 ? "later" : "0"}`);
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
    for (const one of asked) one.expire();
    await queue.idle();
    const trace = `семя ${seed}: ${steps.join(", ")}`;
    assertEquals(bot.twoWithButtons(), "", trace);
    // Все исходы пришли — кнопок не осталось ни у кого.
    assertEquals(bot.buttonedNow(), 0, trace);
  }
});

Deno.test("сбой сети при уступлении — прежнее сообщение остаётся своим: снова активный правит его, второго нет", async () => {
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
  assertEquals(
    bot.calls.filter((call) => call.method === "send").length,
    2,
  );
  assertEquals(bot.calls.at(-1), {
    method: "edit",
    message: 1547,
    text: `${F1_TEXT}\n⌛ истёк — ответьте в терминале`,
    buttons: [],
    data: [],
  });
  assertEquals(bot.buttonedNow(), 1);
  assertEquals(log, [
    "telegram: правка сообщения: бот недоступен: сеть недоступна",
  ]);
  w1.expire();
  await queue.idle();
});
