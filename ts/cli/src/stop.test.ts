/**
 * Строка хука `Stop` через тонкий клиент (`claude-hook-stop.md`,
 * «CLI-контракт»): код 0 и пустой stdout при любом исходе; ключ сессии
 * клиент приносит ядру. Сервер из `back/` поднимается только тестом.
 */

import { assert, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { STOP } from "@mpu/language/frames";
import { withBack } from "../../back/src/backend/testback.ts";
import { FakeBot, fakeQuestions } from "../../back/src/botquestions/testbot.ts";
import { runClient } from "./client.ts";
import { testEnv } from "./testkit.ts";
import { closedPort } from "@mpu/testing";

/** Что увидел вызывающий клиента. */
interface Seen {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function viaClient(
  words: readonly string[],
  setup: {
    base: string;
    main?: string;
    stdin?: string;
    values?: Readonly<Record<string, string>>;
  },
): Promise<Seen> {
  const run = testEnv(setup);
  const code = await runClient(words, run.env);
  return { code, stdout: run.stdout.join(""), stderr: run.stderr.join("") };
}

/** Живой payload `Stop` с транскриптом, которого нет. */
async function stopPayload(message: string): Promise<string> {
  const live = JSON.parse(
    await readFile(
      new URL(
        "../../back/src/claudehook/testdata/stop/live-stop.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return JSON.stringify({
    ...live,
    transcript_path: "/нет/транскрипта",
    last_assistant_message: message,
  });
}

const SESSION = {
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/user/1000/cc-socks/4242.sock",
};

it("сервер строк не отвечает — без вопроса, код 0", async () => {
  const base = `http://127.0.0.1:${await closedPort()}`;
  const seen = await viaClient(STOP.words, {
    base,
    main: "t",
    stdin: await stopPayload("Готово."),
  });
  expect([seen.code, seen.stdout]).toStrictEqual([0, ""]);
  assert(
    seen.stderr.startsWith(
      "mpu claude-hook stop: без вопроса — сервер mpu не отвечает: ",
    ),
    seen.stderr,
  );
});

it("R2a-13 через клиент: бот не настроен — без вопроса, код 0", () =>
  withBack(async (back) => {
    expect(
      await viaClient(STOP.words, {
        base: back.url,
        main: back.token,
        stdin: await stopPayload("Готово."),
      }),
    ).toStrictEqual({
      code: 0,
      stdout: "",
      stderr: STOP.undecided("бот не настроен"),
    });
  }));

it("R2a-1, R2a-9 через клиент: тишина и код 0; ключ сессии дошёл до ядра", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const ask = async (message: string) =>
        await viaClient(STOP.words, {
          base: back.url,
          main: back.token,
          stdin: await stopPayload(message),
          values: SESSION,
        });
      expect(await ask("Вы выбрали: Пн.")).toStrictEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
      await ask("Какой размер?");
      await bot.called(3);
      // Второй конец хода той же сессии снял первый — ключ принёс клиент.
      expect(bot.calls[1].text.split("\n").at(-1)).toBe(
        "✅ решено в терминале",
      );
      expect(bot.calls[2].method).toBe("send");
    },
    { questions: fakeQuestions(bot) },
  );
});

it("R2a-12: справка — однострока, код 0", () =>
  withBack(async (back) => {
    const seen = await viaClient([...STOP.words, "help"], {
      base: back.url,
      main: back.token,
    });
    expect([seen.code, seen.stderr]).toStrictEqual([0, ""]);
    assert(
      seen.stdout.includes(
        "Как сообщить владельцу в Telegram, что сессия Claude Code ждёт ввода?",
      ),
      seen.stdout,
    );
  }));
