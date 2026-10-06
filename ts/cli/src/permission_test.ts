/**
 * Строка хука `PermissionRequest` через тонкий клиент
 * (`claude-hook-permission-request.md`, «CLI-контракт» [D.3]): код 0 при
 * любом исходе ядра и окружения, решение из чата — в stdout как есть.
 * Сервер из `back/` поднимается только тестом.
 */

import { assert, assertEquals } from "@std/assert";
import { PERMISSION_REQUEST } from "../../back/src/frames/mod.ts";
import { withBack } from "../../back/src/backend/testback.ts";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
} from "../../back/src/botquestions/testbot.ts";
import { runClient } from "./client.ts";
import { type Script, testEnv, withFakeServer } from "./testkit.ts";

const WORDS = PERMISSION_REQUEST.words;

/** Что увидел вызывающий клиента. */
interface Seen {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function viaClient(
  words: readonly string[],
  setup: { base: string; main?: string; stdin?: string },
): Promise<Seen> {
  const run = testEnv(setup);
  const code = await runClient(words, run.env);
  return { code, stdout: run.stdout.join(""), stderr: run.stderr.join("") };
}

/** Живой payload права с транскриптом, которого нет. */
async function bashPayload(): Promise<string> {
  const live = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../back/src/claudehook/testdata/permission-request/live-permission-bash.json",
        import.meta.url,
      ),
    ),
  );
  return JSON.stringify({ ...live, transcript_path: "/нет/транскрипта" });
}

Deno.test("сервер строк не отвечает — без решения, код 0", async () => {
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(closed.addr as Deno.NetAddr).port}`;
  closed.close();
  const seen = await viaClient(WORDS, {
    base,
    main: "t",
    stdin: await bashPayload(),
  });
  assertEquals([seen.code, seen.stdout], [0, ""]);
  assert(
    seen.stderr.startsWith(
      "mpu claude-hook permission-request: без решения — сервер mpu не отвечает: сервер строк не отвечает на ",
    ),
    seen.stderr,
  );
  assertEquals(seen.stderr.split("\n").length, 2, seen.stderr);
});

/** Сервер отвечает кадрами `frames` и закрывает сокет. */
function framed(...frames: readonly object[]): Script {
  return (socket) => {
    for (const frame of frames) socket.send(JSON.stringify(frame));
    socket.close(1000);
    return Promise.resolve();
  };
}

Deno.test("код ядра не 0 — «сервер mpu не отвечает» с первой строкой err", () =>
  withFakeServer(
    async (base) => {
      assertEquals(await viaClient(WORDS, { base, main: "t" }), {
        code: 0,
        stdout: "",
        stderr: PERMISSION_REQUEST.undecided(
          "сервер mpu не отвечает: mpu-back: остановлен",
        ),
      });
    },
    { script: framed({ err: "mpu-back: остановлен\n" }, { exit: 1 }) },
  ));

Deno.test("S26: stdin [] — вход не разобран, код 0, в чат ничего", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    assertEquals(
      await viaClient(WORDS, { base: back.url, main: back.token, stdin: "[]" }),
      {
        code: 0,
        stdout: "",
        stderr: PERMISSION_REQUEST.undecided(
          "вход не разобран: stdin — не JSON-объект",
        ),
      },
    );
  }, { questions: fakeQuestions(bot) });
  assertEquals(bot.calls, []);
});

Deno.test("S16: бот не настроен — без решения, код 0", () =>
  withBack(async (back) => {
    assertEquals(
      await viaClient(WORDS, {
        base: back.url,
        main: back.token,
        stdin: await bashPayload(),
      }),
      {
        code: 0,
        stdout: "",
        stderr: PERMISSION_REQUEST.undecided("бот не настроен"),
      },
    );
  }));

Deno.test("S2 через клиент: «Yes» из чата — решение в stdout, код 0", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const seen = viaClient(WORDS, {
      base: back.url,
      main: back.token,
      stdin: await bashPayload(),
    });
    await bot.called(1);
    bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
    assertEquals(await seen, {
      code: 0,
      stdout:
        '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n',
      stderr: "",
    });
  }, { questions: fakeQuestions(bot) });
});

Deno.test("S23: справка — однострока, код 0", () =>
  withBack(async (back) => {
    const seen = await viaClient([...WORDS, "help"], {
      base: back.url,
      main: back.token,
    });
    assertEquals([seen.code, seen.stderr], [0, ""]);
    assert(
      seen.stdout.includes(
        "Как ответить на вопрос Claude Code о праве из Telegram?",
      ),
      seen.stdout,
    );
  }));
