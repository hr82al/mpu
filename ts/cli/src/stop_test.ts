/**
 * Строка хука `Stop` через тонкий клиент (`claude-hook-stop.md`,
 * «CLI-контракт»): код 0 и пустой stdout при любом исходе; ключ сессии
 * клиент приносит ядру. Сервер из `back/` поднимается только тестом.
 */

import { assert, assertEquals } from "@std/assert";
import { STOP } from "../../back/src/frames/mod.ts";
import { withBack } from "../../back/src/backend/testback.ts";
import { FakeBot, fakeQuestions } from "../../back/src/botquestions/testbot.ts";
import { runClient } from "./client.ts";
import { testEnv } from "./testkit.ts";

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
    await Deno.readTextFile(
      new URL(
        "../../back/src/claudehook/testdata/stop/live-stop.json",
        import.meta.url,
      ),
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

Deno.test("сервер строк не отвечает — без вопроса, код 0", async () => {
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(closed.addr as Deno.NetAddr).port}`;
  closed.close();
  const seen = await viaClient(STOP.words, {
    base,
    main: "t",
    stdin: await stopPayload("Готово."),
  });
  assertEquals([seen.code, seen.stdout], [0, ""]);
  assert(
    seen.stderr.startsWith(
      "mpu claude-hook stop: без вопроса — сервер mpu не отвечает: ",
    ),
    seen.stderr,
  );
});

Deno.test("R2a-13 через клиент: бот не настроен — без вопроса, код 0", () =>
  withBack(async (back) => {
    assertEquals(
      await viaClient(STOP.words, {
        base: back.url,
        main: back.token,
        stdin: await stopPayload("Готово."),
      }),
      { code: 0, stdout: "", stderr: STOP.undecided("бот не настроен") },
    );
  }));

Deno.test("R2a-1, R2a-9 через клиент: тишина и код 0; ключ сессии дошёл до ядра", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const ask = async (message: string) =>
      await viaClient(STOP.words, {
        base: back.url,
        main: back.token,
        stdin: await stopPayload(message),
        values: SESSION,
      });
    assertEquals(await ask("Вы выбрали: Пн."), {
      code: 0,
      stdout: "",
      stderr: "",
    });
    await ask("Какой размер?");
    await bot.called(3);
    // Второй конец хода той же сессии снял первый — ключ принёс клиент.
    assertEquals(
      bot.calls[1].text.split("\n").at(-1),
      "✅ решено в терминале",
    );
    assertEquals(bot.calls[2].method, "send");
  }, { questions: fakeQuestions(bot) });
});

Deno.test("R2a-12: справка — однострока, код 0", () =>
  withBack(async (back) => {
    const seen = await viaClient([...STOP.words, "help"], {
      base: back.url,
      main: back.token,
    });
    assertEquals([seen.code, seen.stderr], [0, ""]);
    assert(
      seen.stdout.includes(
        "Как сообщить владельцу в Telegram, что сессия Claude Code ждёт ввода?",
      ),
      seen.stdout,
    );
  }));
