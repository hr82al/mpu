/**
 * Фейк Bot API для тестов вопросов: записывает вызовы по порядку,
 * отвечает номерами сообщений голдена (`testdata/sendMessage.json` —
 * 1546) и отдаёт апдейты пачками, которые кладёт тест.
 */

import { type BotApi, BotFailure, type Keyboard } from "./bot_api.ts";
import type { Entity, Rendered } from "./card.ts";
import { Chat } from "./chat.ts";
import { Form, ONE, type Step, TAKES_TEXT } from "./form.ts";
import { BotQuestions } from "./questions.ts";
import { NO_MEMORY, type ShownMessages } from "./shown.ts";
import { parseUpdates, type Update } from "./updates.ts";

/** Вызов фейка: метод и то, что в нём видно глазами. */
export interface Call {
  readonly method: "send" | "edit" | "ack";
  /** Номер сообщения правки; у прочих — 0. */
  readonly message: number;
  /** Текст сообщения или подсказка нажатия. */
  readonly text: string;
  /** Подписи кнопок по рядам; без кнопок — пусто. */
  readonly buttons: readonly (readonly string[])[];
  /** Данные кнопок по рядам. */
  readonly data: readonly (readonly string[])[];
  /** Выделения текста; нет — поля нет. */
  readonly entities?: readonly Entity[];
}

/** Фейк-бот. */
export class FakeBot implements BotApi {
  readonly calls: Call[] = [];
  #nextId = 1546;
  readonly #failing = new Map<Call["method"], BotFailure>();
  readonly #batches: (readonly Update[])[] = [];
  #waiter = Promise.withResolvers<void>();
  /** Сколько раз звали `updates`. */
  polls = 0;
  readonly #pollWaiters: { count: number; done: () => void }[] = [];
  readonly #callWaiters: { count: number; done: () => void }[] = [];

  /** Ждёт, пока вызовов станет `count`. */
  called(count: number): Promise<void> {
    if (this.calls.length >= count) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    this.#callWaiters.push({ count, done: waiter.resolve });
    return waiter.promise;
  }

  #record(call: Call): void {
    this.calls.push(call);
    for (const waiter of this.#callWaiters) {
      if (this.calls.length >= waiter.count) waiter.done();
    }
  }
  /** Отказы опроса по очереди, до пачек. */
  readonly pollFailures: BotFailure[] = [];

  /** Следующие вызовы `method` отказывают `failure`. */
  fail(method: Call["method"], failure: BotFailure): void {
    this.#failing.set(method, failure);
  }

  /** Снимает отказ `method`. */
  heal(method: Call["method"]): void {
    this.#failing.delete(method);
  }

  /**
   * Ждёт `count`-й вызов `updates`: прошлая пачка к нему доставлена —
   * опрос доставляет пачку целиком, прежде чем спросить следующую.
   */
  polled(count: number): Promise<void> {
    if (this.polls >= count) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    this.#pollWaiters.push({ count, done: waiter.resolve });
    return waiter.promise;
  }

  /** Кладёт пачку апдейтов для опроса. */
  deliver(updates: readonly Update[]): void {
    this.#batches.push(updates);
    this.#waiter.resolve();
  }

  send(message: Rendered, keyboard: Keyboard): Promise<number> {
    this.#record(call("send", 0, message, keyboard));
    const failure = this.#failing.get("send");
    if (failure !== undefined) return Promise.reject(failure);
    const id = this.#nextId;
    this.#nextId += 1;
    this.#buttons(id, keyboard);
    return Promise.resolve(id);
  }

  async edit(id: number, message: Rendered, keyboard: Keyboard): Promise<void> {
    this.#record(call("edit", id, message, keyboard));
    await this.#editGate;
    const failure = this.#failing.get("edit");
    if (failure !== undefined) throw failure;
    this.#buttons(id, keyboard);
  }

  /** Сообщения, у которых в чате сейчас есть кнопки. */
  readonly #withButtons = new Set<number>();
  /** Первый миг, когда кнопки были у двух сообщений сразу. */
  #twice = "";

  /** Удавшийся вызов `message` с клавиатурой `keyboard`. */
  #buttons(message: number, keyboard: Keyboard): void {
    if (keyboard.length > 0) this.#withButtons.add(message);
    else this.#withButtons.delete(message);
    if (this.#withButtons.size > 1 && this.#twice === "") {
      this.#twice = `вызов ${this.calls.length - 1}: кнопки у ${[
        ...this.#withButtons,
      ].join(", ")}`;
    }
  }

  /**
   * Инвариант «в чате не больше одного сообщения с кнопками» по удавшимся
   * вызовам: первое нарушение или пусто.
   */
  twoWithButtons(): string {
    return this.#twice;
  }

  /** Сколько сообщений с кнопками в чате сейчас. */
  buttonedNow(): number {
    return this.#withButtons.size;
  }

  /** Правки, начатые до отпуска, отвечают только после него. */
  #editGate: Promise<void> = Promise.resolve();
  /** Отпуски всех придержаний: любой отпуск открывает все. */
  readonly #holds: (() => void)[] = [];

  /**
   * Придерживает ответы на правки — как медленная сеть: вызов записан,
   * ответа ещё нет. Ответ — отпустить; отпуск отпускает и придержанное
   * раньше, чтобы ни одна правка не осталась без ответа.
   */
  holdEdits(): () => void {
    const gate = Promise.withResolvers<void>();
    this.#editGate = gate.promise;
    this.#holds.push(gate.resolve);
    return () => {
      this.#editGate = Promise.resolve();
      for (const open of this.#holds.splice(0)) open();
    };
  }

  ack(_callback: string, hint: string): Promise<void> {
    this.#record(call("ack", 0, { text: hint, entities: [] }, []));
    const failure = this.#failing.get("ack");
    return failure === undefined ? Promise.resolve() : Promise.reject(failure);
  }

  async updates(
    offset: number,
    signal: AbortSignal,
  ): Promise<readonly Update[]> {
    this.polls += 1;
    this.offsets.push(offset);
    for (const waiter of this.#pollWaiters) {
      if (this.polls >= waiter.count) waiter.done();
    }
    const failure = this.pollFailures.shift();
    if (failure !== undefined) throw failure;
    while (this.#batches.length === 0) {
      signal.throwIfAborted();
      const aborted = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await Promise.race([this.#waiter.promise, aborted.promise]);
      this.#waiter = Promise.withResolvers<void>();
    }
    return this.#batches.shift() ?? [];
  }

  /** `offset` каждого опроса по порядку. */
  readonly offsets: number[] = [];
}

function call(
  method: Call["method"],
  message: number,
  shown: Rendered,
  keyboard: Keyboard,
): Call {
  return {
    method,
    message,
    text: shown.text,
    buttons: keyboard.map((row) => row.map((button) => button.text)),
    data: keyboard.map((row) => row.map((button) => button.data)),
    // Выделения — только когда есть: прежние сверки вызовов их не знают.
    ...(shown.entities.length === 0 ? {} : { entities: shown.entities }),
  };
}

/** Память показанных в массиве: что запомнено сейчас. */
export class ArrayMemory implements ShownMessages {
  readonly #rows = new Map<number, string>();

  remember(id: number, card: { toJSON(): unknown }): void {
    this.#rows.set(id, JSON.stringify(card));
  }

  forget(id: number): void {
    this.#rows.delete(id);
  }

  all() {
    return [];
  }

  /** Номера запомненных сообщений. */
  ids(): readonly number[] {
    return [...this.#rows.keys()];
  }
}

/** Чат поверх фейка; журнал службы — в `log`. */
export function fakeChat(
  bot: FakeBot,
  shown: ShownMessages,
  log: string[],
): Chat {
  return new Chat({ bot, shown, diagnose: (line) => log.push(line) });
}

/** Шаг с головой `head`: один выбор, свой текст — да. */
export function step(
  head: string,
  text: string,
  labels: readonly string[],
): Step {
  return {
    head,
    text,
    options: labels.map((label) => ({ label })),
    choice: ONE,
    reply: TAKES_TEXT,
  };
}

/** F1 постановки: `🔐 Bash — ozon`, один шаг права. */
export function f1(): Form {
  return new Form({
    places: ["ozon"],
    steps: [
      step("🔐 Bash", "Create probe file\ntouch /tmp/x1.txt", [
        "Yes",
        "Yes, always: Bash(touch /tmp/x1.txt)",
        "No",
      ]),
    ],
  });
}

/** F2: второй вопрос другой сессии. */
export function f2(): Form {
  return new Form({
    places: ["sl-back"],
    steps: [step("🔐 Bash", "ls", ["Yes", "No"])],
  });
}

/**
 * Нажатие кнопки `data` пользователем `from` в чате `chat` (по умолчанию
 * — его личном) — апдейт `id`.
 */
export function pressUpdate(
  id: number,
  from: number,
  data: string,
  chat: number = from,
): Update {
  return parseUpdates([
    {
      update_id: id,
      callback_query: {
        id: `cb${id}`,
        from: { id: from },
        message: { chat: { id: chat } },
        data,
      },
    },
  ])[0];
}

/**
 * Текст `text` пользователя `from` с датой `date` (секунды) в чате
 * `chat` (по умолчанию — его личном).
 */
export function textUpdate(
  id: number,
  from: number,
  text: string,
  date: number,
  chat: number = from,
): Update {
  return parseUpdates([
    {
      update_id: id,
      message: {
        message_id: id,
        from: { id: from },
        chat: { id: chat },
        date,
        text,
      },
    },
  ])[0];
}

/**
 * Служба вопросов на фейке для потребителей (хук `PermissionRequest`):
 * владелец `111`, метка запуска `r1`, опрос без пауз; журнал — `log`.
 */
export function fakeQuestions(bot: FakeBot, log: string[] = []): BotQuestions {
  return new BotQuestions({
    bot,
    owner: 111,
    shown: NO_MEMORY,
    clock: { now: () => 0, pause: () => Promise.resolve() },
    run: "r1",
    diagnose: (line) => log.push(line),
  });
}
