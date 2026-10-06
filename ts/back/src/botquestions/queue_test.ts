/**
 * Ряд вопросов и сообщение с кнопками
 * (`docs/specs/platform/telegram-questions.md`; сценарии постановки R1a —
 * номерами в именах тестов). Чат — фейк Bot API, вызовы сверяются по
 * порядку.
 */

import { assertEquals } from "@std/assert";
import { BotFailure } from "./bot_api.ts";
import { BUTTONS_ONLY, Form, MANY, ONE, TAKES_TEXT } from "./form.ts";
import type { OutcomeReader, StepAnswerReader } from "./outcome.ts";
import { Queue } from "./queue.ts";
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
