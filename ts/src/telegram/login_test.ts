/**
 * Ветки входа — все, кроме самого входа: он требует настоящего
 * телефона и кода из Telegram, а успешный вход **отзывает
 * действующую сессию владельца** (`docs/specs/telegram-login.md`,
 * «Проверка — и её честная граница»).
 *
 * Клиент здесь — двойник наших веток, а не форма ответов Telegram: он
 * эталоном стыка не является и не притворяется им.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { TerminalIo } from "../command/mod.ts";
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
  onSet?: (name: string, value: string) => void;
}): Stand {
  const written: Record<string, string> = {};
  const progress: string[] = [];
  const asked: string[] = [];
  const secretAsked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const secrets = [...(opts.secrets ?? [])];
  const state = { opened: 0 };
  const terminal: TerminalIo = {
    name: undefined,
    write: (text) => {
      asked.push(text);
      return Promise.resolve();
    },
    readLine: () => Promise.resolve(answers.shift()),
    readSecret: () => {
      secretAsked.push(asked[asked.length - 1] ?? "");
      return Promise.resolve(secrets.shift());
    },
    [Symbol.dispose]: () => {},
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
    terminal: opts.terminal === false ? undefined : terminal,
    progress: (line) => void progress.push(line),
    openClient: () => {
      state.opened++;
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

Deno.test("сессия уже есть: вход не запускается, env-файл не трогается", async () => {
  // Повторный вход отзывает прежнюю сессию — идемпотентность здесь
  // защита, а не удобство (спека, шаг 1).
  const stand = makeStand({ keys: { [SESSION_KEY]: "живая-сессия" } });
  assertEquals(await runLogin(stand.io), { status: "already" });
  assertEquals(stand.written, {});
  assertEquals(stand.opened, 0, "клиент не должен создаваться");
  assertEquals(stand.progress, ["# telegram: уже авторизован"]);
});

Deno.test("ввод не с терминала: пропуск с подсказкой и без записи", async () => {
  // Код 0, а не отказ: та же реализация — шаг `mpu init`, и падение
  // на ней сломало бы bootstrap (инвариант 3).
  const stand = makeStand({ terminal: false });
  const result = await runLogin(stand.io);
  assertEquals(result.status, "skipped");
  assertEquals(
    stand.progress,
    ["# telegram: пропущено (нет TTY; заполни TELEGRAM_API_ID/HASH в .env вручную)"],
  );
  assertEquals(stand.written, {});
  assertEquals(stand.opened, 0);
});

Deno.test("нет ключей приложения: согласие спрашивается, отказ ничего не пишет", async (t) => {
  await t.step("отказ пользователя", async () => {
    const stand = makeStand({ answers: ["n"] });
    const result = await runLogin(stand.io);
    assertEquals(result.status, "skipped");
    assertEquals(
      result.reason,
      "позже: заполнить TELEGRAM_API_ID/HASH в .env и `mpu telegram login`",
    );
    assertEquals(stand.written, {}, "env-файл не тронут");
    assertEquals(stand.opened, 0);
    // Где взять ключи — сказано до вопроса, а не после отказа.
    assertEquals(
      stand.progress[0].includes("https://my.telegram.org/apps"),
      true,
      stand.progress.join("\n"),
    );
  });

  await t.step("согласие с пустым вводом — тоже ни байта", async () => {
    // Замер оригинала 2026-08-31: файл остался нулевого размера, код 0.
    const stand = makeStand({ answers: ["y", "", ""] });
    const result = await runLogin(stand.io);
    assertEquals(result, {
      status: "skipped",
      reason: "api_id/api_hash пустые",
    });
    assertEquals(stand.written, {});
    assertEquals(stand.opened, 0);
  });

  await t.step(
    "api_id не число — пропуск, и в файл ничего не легло",
    async () => {
      // Записанный мусор перестал бы спрашиваться и ронял бы каждый
      // следующий вход, пока оператор не поправит .env руками.
      const stand = makeStand({ answers: ["y", "не-число", "hash"] });
      assertEquals(await runLogin(stand.io), {
        status: "skipped",
        reason: "api_id не целое число",
      });
      assertEquals(stand.written, {});
      assertEquals(stand.opened, 0);
    },
  );

  await t.step("ключи введены — записаны, вход продолжается", async () => {
    const stand = makeStand({
      answers: [
        "y",
        "12345",
        "0123456789abcdef0123456789abcdef",
        "+70001112233",
      ],
    });
    assertEquals(await runLogin(stand.io), { status: "logged-in" });
    assertEquals(stand.written[API_ID_KEY], "12345");
    assertEquals(
      stand.written[API_HASH_KEY],
      "0123456789abcdef0123456789abcdef",
    );
    assertEquals(stand.written[PHONE_KEY], "+70001112233");
    assertEquals(stand.written[SESSION_KEY], SESSION);
  });
});

Deno.test("телефон: из env-файла берётся молча, введённый сохраняется", async (t) => {
  const keys = {
    [API_ID_KEY]: "1",
    [API_HASH_KEY]: "hash",
  };
  await t.step("уже сохранён — не спрашивается", async () => {
    const stand = makeStand({ keys: { ...keys, [PHONE_KEY]: "+70001112233" } });
    assertEquals(await runLogin(stand.io), { status: "logged-in" });
    assertEquals(stand.asked, [], "лишний вопрос человеку");
    assertEquals(stand.written, { [SESSION_KEY]: SESSION });
  });

  await t.step("введён — сохраняется и переживает неудачный вход", async () => {
    // Телефон не секрет доступа, поэтому он записывается до входа
    // (инвариант 2 спеки).
    const stand = makeStand({
      keys,
      answers: ["+70001112233"],
      signIn: () => Promise.reject(new Error("код не подошёл")),
    });
    await assertRejects(() => runLogin(stand.io), Error, "код не подошёл");
    assertEquals(stand.written, { [PHONE_KEY]: "+70001112233" });
  });
});

Deno.test("пароль второго фактора спрашивается скрыто и не сохраняется", async () => {
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
  assertEquals(await runLogin(stand.io), { status: "logged-in" });
  // Скрытым спрошен ровно пароль, а код — обычным вводом.
  assertEquals(stand.secretAsked, ["2FA password: "]);
  // Пароль не сохраняется вовсе (инвариант 1 спеки).
  assertEquals(Object.keys(stand.written), [SESSION_KEY]);
  assertEquals(
    JSON.stringify(stand.written).includes("пароль-второго-фактора"),
    false,
  );
});

Deno.test("строка сессии не появляется ни в одном тексте наружу", async () => {
  const keys = { [API_ID_KEY]: "1", [API_HASH_KEY]: "hash", [PHONE_KEY]: "+7" };
  const stand = makeStand({ keys });
  const result = await runLogin(stand.io);
  const outside = [
    JSON.stringify(result),
    stand.progress.join("\n"),
    stand.asked.join("\n"),
  ].join("\n");
  assertEquals(outside.includes(SESSION), false, outside);
  // А в env-файл она ушла — иначе проверять было бы нечего.
  assertEquals(stand.written[SESSION_KEY], SESSION);
});

Deno.test("отказ записи сессии не выносит её в текст ошибки", async () => {
  const keys = { [API_ID_KEY]: "1", [API_HASH_KEY]: "hash", [PHONE_KEY]: "+7" };
  const stand = makeStand({
    keys,
    onSet: (name) => {
      if (name === SESSION_KEY) {
        throw new Error(`cannot write env value for ${name}`);
      }
    },
  });
  const err = await assertRejects(() => runLogin(stand.io), Error);
  assertEquals(err.message.includes(SESSION), false, err.message);
});
