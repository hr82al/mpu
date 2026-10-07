/**
 * Строка хука `PermissionRequest` через тонкий клиент
 * (`claude-hook-permission-request.md`, «CLI-контракт» [D.3]): код 0 при
 * любом исходе ядра и окружения, решение из чата — в stdout как есть.
 * Сервер из `back/` поднимается только тестом.
 */

import { assert, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PERMISSION_REQUEST } from "../../back/src/frames/mod.ts";
import { withBack } from "../../back/src/backend/testback.ts";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
} from "../../back/src/botquestions/testbot.ts";
import { runClient } from "./client.ts";
import { type Script, testEnv, withFakeServer } from "./testkit.ts";
import { closedPort } from "../../back/src/testing/http.ts";

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
    await readFile(
      new URL(
        "../../back/src/claudehook/testdata/permission-request/live-permission-bash.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return JSON.stringify({ ...live, transcript_path: "/нет/транскрипта" });
}

it("сервер строк не отвечает — без решения, код 0", async () => {
  const base = `http://127.0.0.1:${await closedPort()}`;
  const seen = await viaClient(WORDS, {
    base,
    main: "t",
    stdin: await bashPayload(),
  });
  expect([seen.code, seen.stdout]).toStrictEqual([0, ""]);
  assert(
    seen.stderr.startsWith(
      "mpu claude-hook permission-request: без решения — сервер mpu не отвечает: сервер строк не отвечает на ",
    ),
    seen.stderr,
  );
  expect(seen.stderr.split("\n").length, seen.stderr).toBe(2);
});

/** Сервер отвечает кадрами `frames` и закрывает сокет. */
function framed(...frames: readonly object[]): Script {
  return (socket) => {
    for (const frame of frames) socket.send(JSON.stringify(frame));
    socket.close(1000);
    return Promise.resolve();
  };
}

it("код ядра не 0 — «сервер mpu не отвечает» с первой строкой err", () =>
  withFakeServer(
    async (base) => {
      expect(await viaClient(WORDS, { base, main: "t" })).toStrictEqual({
        code: 0,
        stdout: "",
        stderr: PERMISSION_REQUEST.undecided(
          "сервер mpu не отвечает: mpu-back: остановлен",
        ),
      });
    },
    { script: framed({ err: "mpu-back: остановлен\n" }, { exit: 1 }) },
  ));

it("S26: stdin [] — вход не разобран, код 0, в чат ничего", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      expect(
        await viaClient(WORDS, {
          base: back.url,
          main: back.token,
          stdin: "[]",
        }),
      ).toStrictEqual({
        code: 0,
        stdout: "",
        stderr: PERMISSION_REQUEST.undecided(
          "вход не разобран: stdin — не JSON-объект",
        ),
      });
    },
    { questions: fakeQuestions(bot) },
  );
  expect(bot.calls).toStrictEqual([]);
});

it("S16: бот не настроен — без решения, код 0", () =>
  withBack(async (back) => {
    expect(
      await viaClient(WORDS, {
        base: back.url,
        main: back.token,
        stdin: await bashPayload(),
      }),
    ).toStrictEqual({
      code: 0,
      stdout: "",
      stderr: PERMISSION_REQUEST.undecided("бот не настроен"),
    });
  }));

it("S2 через клиент: «Yes» из чата — решение в stdout, код 0", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const seen = viaClient(WORDS, {
        base: back.url,
        main: back.token,
        stdin: await bashPayload(),
      });
      await bot.called(1);
      bot.deliver([pressUpdate(1, 111, "r1:1:0:0")]);
      expect(await seen).toStrictEqual({
        code: 0,
        stdout:
          '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n',
        stderr: "",
      });
    },
    { questions: fakeQuestions(bot) },
  );
});

it("S23: справка — однострока, код 0", () =>
  withBack(async (back) => {
    const seen = await viaClient([...WORDS, "help"], {
      base: back.url,
      main: back.token,
    });
    expect([seen.code, seen.stderr]).toStrictEqual([0, ""]);
    assert(
      seen.stdout.includes(
        "Как ответить на вопрос Claude Code о праве из Telegram?",
      ),
      seen.stdout,
    );
  }));
