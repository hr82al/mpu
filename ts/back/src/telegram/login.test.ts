/**
 * Ветки входа — все, кроме самого входа: он требует настоящего
 * телефона и кода из Telegram, а успешный вход **отзывает
 * действующую сессию владельца** (`docs/specs/telegram-login.md`,
 * «Проверка — и её честная граница»).
 *
 * Клиент здесь — двойник наших веток, а не форма ответов Telegram: он
 * эталоном стыка не является и не притворяется им.
 */

import { describe, expect, it } from "vitest";
import { rejected } from "../testing/thrown.ts";
import { NO_ONE, type Prompt } from "../command/mod.ts";
import { configError } from "./errors.ts";
import {
  API_HASH_KEY,
  API_ID_KEY,
  type LoginClient,
  type LoginIo,
  PHONE_KEY,
  runLogin,
  SESSION_KEY,
} from "./login.ts";

/** Строка-метка вместо сессии: её и ищем во всех выводах. */
const SESSION = "СЕКРЕТ-СЕССИИ-1a2b3c";

interface Stand {
  readonly io: LoginIo;
  readonly written: Record<string, string>;
  readonly progress: string[];
  readonly asked: string[];
  readonly secretAsked: string[];
  readonly opened: number;
}

/** Терминал-двойник: отвечает по очереди, скрытый ввод — отдельно. */
function makeStand(opts: {
  keys?: Record<string, string>;
  answers?: readonly (string | undefined)[];
  secrets?: readonly (string | undefined)[];
  terminal?: boolean;
  session?: string;
  signIn?: LoginClient["signIn"];
  /** Отказ открытия клиента; не задан — клиент открывается. */
  openFailure?: Error;
  onSet?: (name: string, value: string) => void;
}): Stand {
  const written: Record<string, string> = {};
  const progress: string[] = [];
  const asked: string[] = [];
  const secretAsked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const secrets = [...(opts.secrets ?? [])];
  const state = { opened: 0 };
  /** Спрошенный сценарием: очередь заготовленных ответов по видам. */
  const prompt: Prompt = {
    line: (question, answer) => {
      asked.push(question);
      const text = answers.shift();
      return Promise.resolve(
        text === undefined ? answer.absent() : answer.given(text),
      );
    },
    secret: (question, answer) => {
      asked.push(question);
      secretAsked.push(question);
      const text = secrets.shift();
      return Promise.resolve(
        text === undefined ? answer.absent() : answer.given(text),
      );
    },
    copy: () => Promise.reject(new Error("copy не ожидается")),
  };
  const io: LoginIo = {
    envFile: {
      get: (name) => ({ ...opts.keys })[name],
      set: (name, value) => {
        opts.onSet?.(name, value);
        written[name] = value;
        return Promise.resolve();
      },
    },
    prompt: opts.terminal === false ? NO_ONE : prompt,
    progress: (line) => void progress.push(line),
    openClient: () => {
      state.opened++;
      if (opts.openFailure !== undefined) {
        return Promise.reject(opts.openFailure);
      }
      return Promise.resolve({
        signIn: opts.signIn ??
          (() => Promise.resolve(opts.session ?? SESSION)),
        close: () => Promise.resolve(),
      });
    },
  };
  return {
    io,
    written,
    progress,
    asked,
    secretAsked,
    get opened() {
      return state.opened;
    },
  };
}

it("сессия уже есть: вход не запускается, env-файл не трогается", async () => {
  // Повторный вход отзывает прежнюю сессию — идемпотентность здесь
  // защита, а не удобство (спека, шаг 1).
  const stand = makeStand({ keys: { [SESSION_KEY]: "живая-сессия" } });
  expect(await runLogin(stand.io)).toStrictEqual({ status: "already" });
  expect(stand.written).toStrictEqual({});
  expect(stand.opened, "клиент не должен создаваться").toBe(0);
  expect(stand.progress).toStrictEqual(["# telegram: уже авторизован"]);
});

it("ввод не с терминала: пропуск с подсказкой и без записи", async () => {
  // Код 0, а не отказ: та же реализация — шаг `mpu init`, и падение
  // на ней сломало бы bootstrap (инвариант 3).
  const stand = makeStand({ terminal: false });
  const result = await runLogin(stand.io);
  expect(result.status).toBe("skipped");
  expect(stand.progress).toStrictEqual([
    "# telegram: ключей приложения нет; взять их — https://my.telegram.org/apps",
    "# telegram: пропущено (нет TTY; заполни TELEGRAM_API_ID/HASH в .env вручную)",
  ]);
  expect(stand.written).toStrictEqual({});
  expect(stand.opened).toBe(0);
});

describe("нет ключей приложения: согласие спрашивается, отказ ничего не пишет", () => {
  it("отказ пользователя", async () => {
    const stand = makeStand({ answers: ["n"] });
    const result = await runLogin(stand.io);
    expect(result).toStrictEqual({
      status: "skipped",
      reason:
        "позже: заполнить TELEGRAM_API_ID/HASH в .env и `mpu telegram login`",
    });
    expect(stand.written, "env-файл не тронут").toStrictEqual({});
    expect(stand.opened).toBe(0);
    // Где взять ключи — сказано до вопроса, а не после отказа.
    expect(
      stand.progress[0].includes("https://my.telegram.org/apps"),
      stand.progress.join("\n"),
    ).toBe(true);
  });

  it("согласие с пустым вводом — тоже ни байта", async () => {
    // Замер оригинала 2026-08-31: файл остался нулевого размера, код 0.
    const stand = makeStand({ answers: ["y", "", ""] });
    const result = await runLogin(stand.io);
    expect(result).toStrictEqual({
      status: "skipped",
      reason: "api_id/api_hash пустые",
    });
    expect(stand.written).toStrictEqual({});
    expect(stand.opened).toBe(0);
  });

  it("api_id не число — пропуск, и в файл ничего не легло", async () => {
    // Записанный мусор перестал бы спрашиваться и ронял бы каждый
    // следующий вход, пока оператор не поправит .env руками.
    const stand = makeStand({ answers: ["y", "не-число", "hash"] });
    expect(await runLogin(stand.io)).toStrictEqual({
      status: "skipped",
      reason: "api_id не целое число",
    });
    expect(stand.written).toStrictEqual({});
    expect(stand.opened).toBe(0);
  });

  it("ключи введены — записаны, вход продолжается", async () => {
    const stand = makeStand({
      answers: [
        "y",
        "12345",
        "0123456789abcdef0123456789abcdef",
        "+70001112233",
      ],
    });
    expect(await runLogin(stand.io)).toStrictEqual({ status: "logged-in" });
    expect(stand.written[API_ID_KEY]).toBe("12345");
    expect(stand.written[API_HASH_KEY]).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(stand.written[PHONE_KEY]).toBe("+70001112233");
    expect(stand.written[SESSION_KEY]).toStrictEqual(SESSION);
  });
});

describe("телефон: из env-файла берётся молча, введённый сохраняется", () => {
  const keys = {
    [API_ID_KEY]: "1",
    [API_HASH_KEY]: "hash",
  };
  it("уже сохранён — не спрашивается", async () => {
    const stand = makeStand({ keys: { ...keys, [PHONE_KEY]: "+70001112233" } });
    expect(await runLogin(stand.io)).toStrictEqual({ status: "logged-in" });
    expect(stand.asked, "лишний вопрос человеку").toStrictEqual([]);
    expect(stand.written).toStrictEqual({ [SESSION_KEY]: SESSION });
  });

  it("введён — сохраняется и переживает неудачный вход", async () => {
    // Телефон не секрет доступа, поэтому он записывается до входа
    // (инвариант 2 спеки). Сбой самого входа — отказ, оформленный слоем, —
    // «пропущено» с причиной (инвариант 3): первая строка текста отказа.
    const stand = makeStand({
      keys,
      answers: ["+70001112233"],
      signIn: () =>
        Promise.reject(
          configError("RPC error: PHONE_CODE_INVALID\nподробности"),
        ),
    });
    expect(await runLogin(stand.io)).toStrictEqual({
      status: "skipped",
      reason: "telegram: RPC error: PHONE_CODE_INVALID",
    });
    expect(stand.progress.at(-1)).toBe(
      "# telegram: пропущено (telegram: RPC error: PHONE_CODE_INVALID)",
    );
    expect(stand.written).toStrictEqual({ [PHONE_KEY]: "+70001112233" });
  });
});

it("пароль второго фактора спрашивается скрыто и не сохраняется", async () => {
  const keys = { [API_ID_KEY]: "1", [API_HASH_KEY]: "hash", [PHONE_KEY]: "+7" };
  const stand = makeStand({
    keys,
    answers: ["12345"],
    secrets: ["пароль-второго-фактора"],
    signIn: async (_phone, prompts) => {
      await prompts.ask("code: ");
      await prompts.askSecret("2FA password: ");
      return SESSION;
    },
  });
  expect(await runLogin(stand.io)).toStrictEqual({ status: "logged-in" });
  // Скрытым спрошен ровно пароль, а код — обычным вводом.
  expect(stand.secretAsked).toStrictEqual(["2FA password: "]);
  // Пароль не сохраняется вовсе (инвариант 1 спеки).
  expect(Object.keys(stand.written)).toStrictEqual([SESSION_KEY]);
  expect(JSON.stringify(stand.written).includes("пароль-второго-фактора")).toBe(
    false,
  );
});

it("строка сессии не появляется ни в одном тексте наружу", async () => {
  const keys = { [API_ID_KEY]: "1", [API_HASH_KEY]: "hash", [PHONE_KEY]: "+7" };
  const stand = makeStand({ keys });
  const result = await runLogin(stand.io);
  const outside = [
    JSON.stringify(result),
    stand.progress.join("\n"),
    stand.asked.join("\n"),
  ].join("\n");
  expect(outside.includes(SESSION), outside).toBe(false);
  // А в env-файл она ушла — иначе проверять было бы нечего.
  expect(stand.written[SESSION_KEY]).toStrictEqual(SESSION);
});

it("отказ записи сессии не выносит её в текст ошибки", async () => {
  const keys = { [API_ID_KEY]: "1", [API_HASH_KEY]: "hash", [PHONE_KEY]: "+7" };
  const stand = makeStand({
    keys,
    onSet: (name) => {
      if (name === SESSION_KEY) {
        throw new Error(`cannot write env value for ${name}`);
      }
    },
  });
  const err = await rejected(() => runLogin(stand.io), Error);
  expect(err.message.includes(SESSION), err.message).toBe(false);
});

describe("не сбой самого входа — не пропуск: отказ всплывает как есть", () => {
  // Инвариант 3, «Что считается сбоем самого входа»: пропуск — только за
  // отказ, оформленный слоем; дефект своего кода и отказ терминала — код 1
  // с исходным текстом, иначе ошибка программы маскируется под отказ Telegram.
  const keys = {
    [API_ID_KEY]: "1",
    [API_HASH_KEY]: "hash",
    [PHONE_KEY]: "+70001112233",
  };
  const cases: ReadonlyArray<
    readonly [string, Parameters<typeof makeStand>[0], Error]
  > = [
    (() => {
      const bug = new TypeError("Cannot read properties of undefined");
      return [
        "дефект кода при сборке клиента",
        { keys, openFailure: bug },
        bug,
      ] as const;
    })(),
    (() => {
      const bug = new TypeError("дефект своего кода во входе");
      return [
        "дефект кода внутри входа",
        { keys, signIn: () => Promise.reject(bug) },
        bug,
      ] as const;
    })(),
    (() => {
      const refused = new Error("терминал: не удалось прочитать ответ");
      return [
        "отказ терминала на вопросе кода",
        { keys, signIn: () => Promise.reject(refused) },
        refused,
      ] as const;
    })(),
  ];
  for (const [name, opts, expected] of cases) {
    it(name, async () => {
      const stand = makeStand(opts);
      await expect(runLogin(stand.io)).rejects.toBe(expected);
      expect(
        stand.progress.some((line) => line.includes("пропущено")),
        stand.progress.join("\n"),
      ).toBe(false);
      expect(stand.written).toStrictEqual({});
    });
  }
});
