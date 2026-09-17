/**
 * Отдельный `mpu telegram login` через публичный вход: сбой самого входа —
 * «пропущено» с причиной и код 0, как у шага `mpu init`
 * (`docs/specs/telegram-login.md`, инвариант 3). Живой вход не
 * запускается: оба случая отказывают до сети.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { EnvFile, TerminalIo } from "../command/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
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
  const { extra = {}, broken, argv = ["telegram", "login"], stderr: err = [] } =
    run;
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
  const terminal: TerminalIo = {
    name: undefined,
    write: () => Promise.resolve(),
    readLine: () => Promise.resolve(answers.shift()),
    readSecret: () => Promise.resolve(undefined),
    [Symbol.dispose]: () => {},
  };
  const code = await runCli(
    argv,
    makeFakeIo({ envFile, openTerminal: () => Promise.resolve(terminal) }),
    { stdout: () => {}, stderr: (text) => void err.push(text) },
  );
  return { code, stderr: err.join(""), written };
}

Deno.test("mpu telegram login: сбой самого входа — пропущено с причиной и код 0", async (t) => {
  await t.step("сбой криптографии — причина текстом спеки", async () => {
    const realReadFile = Deno.readFile;
    try {
      Deno.readFile = () =>
        Promise.reject(new Deno.errors.NotFound("нет встроенного модуля"));
      const { code, stderr, written } = await login();
      assertEquals(code, 0, stderr);
      assertStringIncludes(
        stderr,
        "# telegram: пропущено (telegram: криптография клиента не поднялась: нет встроенного модуля)\n",
      );
      // Инвариант 2: сессии нет, введённый телефон переживает отказ.
      assertEquals(written, { TELEGRAM_PHONE: "+70001112233" });
    } finally {
      Deno.readFile = realReadFile;
    }
  });

  await t.step("битый прокси — причина текстом слоя", async () => {
    const { code, stderr, written } = await login({
      extra: { TELEGRAM_PROXY: "ftp://127.0.0.1:1" },
    });
    assertEquals(code, 0, stderr);
    assertStringIncludes(
      stderr,
      "# telegram: пропущено (telegram: неподдерживаемая схема прокси 'ftp'",
    );
    assertEquals(stderr.includes("криптография"), false, stderr);
    assertEquals(written, { TELEGRAM_PHONE: "+70001112233" });
  });
});

Deno.test("mpu telegram login: дефект кода — не пропуск, а исходная ошибка наружу", async () => {
  // Сборка клиента читает прокси из env-файла; дефект там — не отказ
  // Telegram (инвариант 3, «Что считается сбоем самого входа»). Команда не
  // оформляет его и не пропускает: ошибка уходит из `runCli` как есть, а
  // код 1 и строку `mpu: unexpected error` ставит точка входа (`main.ts`).
  const stderr: string[] = [];
  await assertRejects(
    () => login({ broken: "TELEGRAM_PROXY", stderr }),
    TypeError,
    "дефект чтения TELEGRAM_PROXY",
  );
  const printed = stderr.join("");
  assertEquals(printed.includes("пропущено"), false, printed);
  assertEquals(printed.includes("RPC error"), false, printed);
});

Deno.test("mpu telegram login: неверный вызов — код 2", async () => {
  const { code, written } = await login({ argv: ["telegram", "login", "--x"] });
  assertEquals(code, 2);
  assertEquals(written, {});
});

Deno.test("справка mpu telegram login называет все три кода выхода", () => {
  // Коды — часть контракта (`telegram-login.md`, инвариант 3): абзац
  // держится дословно, иначе справка молча разойдётся с поведением.
  const exit = telegramLoginCommand.help.slice(
    telegramLoginCommand.help.indexOf("Exit:"),
  );
  assertEquals(
    exit,
    "Exit: 0 — успех и любой пропуск, в том числе сбой самого входа; 2 —\n" +
      "неверный вызов (лишняя опция); 1 — сбой вне сценария: дефект\n" +
      "программы, отказ терминала, записи env-файла или закрытия клиента.",
  );
});
