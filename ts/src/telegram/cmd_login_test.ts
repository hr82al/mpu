/**
 * Отдельный `mpu telegram login` через публичный вход: сбой самого входа —
 * «пропущено» с причиной и код 0, как у шага `mpu init`
 * (`docs/specs/telegram-login.md`, инвариант 3). Живой вход не
 * запускается: оба случая отказывают до сети.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { EnvFile, TerminalIo } from "../command/mod.ts";
import { runCli } from "../entrypoint/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";

/** Прогон команды: env-файл в памяти, телефон вводится с терминала. */
async function login(
  extra: Readonly<Record<string, string>>,
): Promise<{ code: number; stderr: string; written: Record<string, string> }> {
  const values: Record<string, string> = {
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "проба",
    ...extra,
  };
  const written: Record<string, string> = {};
  const envFile: EnvFile = {
    get: (name) => values[name],
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
  const err: string[] = [];
  const code = await runCli(
    ["telegram", "login"],
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
      const { code, stderr, written } = await login({});
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
      TELEGRAM_PROXY: "ftp://127.0.0.1:1",
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
