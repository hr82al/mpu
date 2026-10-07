/**
 * Отдельный `mpu telegram login` через публичный вход: сбой самого входа —
 * «пропущено» с причиной и код 0, как у шага `mpu init`
 * (`docs/specs/telegram-login.md`, инвариант 3). Живой вход не
 * запускается: оба случая отказывают до сети.
 */

import { describe, expect, it } from "vitest";
import type { EnvFile, Prompt } from "../command/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo, promptQueue } from "../testing/mod.ts";
import { rejected } from "@mpu/testing/thrown";
import { telegramLoginCommand } from "./cmd_login.ts";

/** Что меняет прогон команды относительно обычного. */
interface LoginRun {
  /** Ключи env-файла сверх ключей приложения. */
  readonly extra?: Readonly<Record<string, string>>;
  /** Ключ, чтение которого ломается дефектом кода. */
  readonly broken?: string;
  readonly argv?: readonly string[];
  /** Куда складывать stderr — нужен, когда прогон отклоняется. */
  readonly stderr?: string[];
}

/** Прогон команды: env-файл в памяти, телефон вводится с терминала. */
async function login(
  run: LoginRun = {},
): Promise<{ code: number; stderr: string; written: Record<string, string> }> {
  const {
    extra = {},
    broken,
    argv = ["telegram", "login"],
    stderr: err = [],
  } = run;
  const values: Record<string, string> = {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
    ...extra,
  };
  const written: Record<string, string> = {};
  const envFile: EnvFile = {
    get: (name) => {
      if (name === broken) throw new TypeError(`дефект чтения ${name}`);
      return values[name];
    },
    require: (name) => values[name] ?? "",
    set: (name, value) => {
      written[name] = value;
      values[name] = value;
      return Promise.resolve();
    },
    values: () => ({ ...values }),
  };
  const answers = ["+70001112233"];
  const prompt: Prompt = promptQueue(answers);
  const code = await runCli(argv, makeFakeIo({ envFile, prompt }), {
    stdout: () => {},
    stderr: (text) => void err.push(text),
  });
  return { code, stderr: err.join(""), written };
}

describe("mpu telegram login: сбой самого входа — пропущено с причиной и код 0", () => {
  it("сбой криптографии — причина текстом спеки", async () => {
    // Байты модуля встроены, читать нечего: сбой подделывается в
    // `WebAssembly.Module`, которым `initSync` разбирает модуль. Работает,
    // лишь пока модуль не поднят: у поднятого `initSync` — пустой вызов, и
    // тогда строки сбоя криптографии нет — случай краснеет на ней.
    const real = WebAssembly.Module;
    Reflect.set(WebAssembly, "Module", function () {
      throw new Error("нет встроенного модуля");
    });
    try {
      const { code, stderr, written } = await login();
      expect(code, stderr).toBe(0);
      expect(stderr).toContain(
        "# telegram: пропущено (telegram: криптография клиента не поднялась: нет встроенного модуля)\n",
      );
      // Инвариант 2: сессии нет, введённый телефон переживает отказ.
      expect(written).toStrictEqual({ TELEGRAM_PHONE: "+70001112233" });
    } finally {
      Reflect.set(WebAssembly, "Module", real);
    }
  });

  it("битый прокси — причина текстом слоя", async () => {
    const { code, stderr, written } = await login({
      extra: { TELEGRAM_PROXY: "ftp://127.0.0.1:1" },
    });
    expect(code, stderr).toBe(0);
    expect(stderr).toContain(
      "# telegram: пропущено (telegram: неподдерживаемая схема прокси 'ftp'",
    );
    expect(stderr.includes("криптография"), stderr).toBe(false);
    expect(written).toStrictEqual({ TELEGRAM_PHONE: "+70001112233" });
  });
});

it("mpu telegram login: дефект кода — не пропуск, а исходная ошибка наружу", async () => {
  // Сборка клиента читает прокси из env-файла; дефект там — не отказ
  // Telegram (инвариант 3, «Что считается сбоем самого входа»). Команда не
  // оформляет его и не пропускает: ошибка уходит из `runCli` как есть, а
  // код 1 и строку `mpu: unexpected error` ставит точка входа (`main.ts`).
  const stderr: string[] = [];
  await rejected(
    () => login({ broken: "TELEGRAM_PROXY", stderr }),
    TypeError,
    "дефект чтения TELEGRAM_PROXY",
  );
  const printed = stderr.join("");
  expect(printed.includes("пропущено"), printed).toBe(false);
  expect(printed.includes("RPC error"), printed).toBe(false);
});

it("mpu telegram login: неверный вызов — код 2", async () => {
  const { code, written } = await login({ argv: ["telegram", "login", "--x"] });
  expect(code).toBe(2);
  expect(written).toStrictEqual({});
});

it("справка mpu telegram login называет все три кода выхода", () => {
  // Коды — часть контракта (`telegram-login.md`, инвариант 3): абзац
  // держится дословно, иначе справка молча разойдётся с поведением.
  const exit = telegramLoginCommand.help.slice(
    telegramLoginCommand.help.indexOf("Exit:"),
  );
  expect(exit).toBe(
    "Exit: 0 — успех и любой пропуск, в том числе сбой самого входа; 2 —\n" +
      "неверный вызов (лишняя опция); 1 — сбой вне сценария: дефект\n" +
      "программы, отказ терминала, записи env-файла или закрытия клиента.",
  );
});
