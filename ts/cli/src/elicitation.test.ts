/**
 * Строка хука `Elicitation` через тонкий клиент
 * (`claude-hook-elicitation.md`, «CLI-контракт»): код 0 при любом исходе,
 * решение — в stdout, без решения — строка в stderr. Сервер из `back/`
 * поднимается только тестом.
 */

import { assert, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { ELICITATION } from "../../back/src/frames/mod.ts";
import { withBack } from "../../back/src/backend/testback.ts";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
} from "../../back/src/botquestions/testbot.ts";
import { runClient } from "./client.ts";
import { testEnv } from "./testkit.ts";
import { closedPort } from "../../back/src/testing/http.ts";

/** Что увидел вызывающий клиента. */
interface Seen {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function viaClient(setup: {
  base: string;
  main?: string;
  stdin?: string;
}): Promise<Seen> {
  const run = testEnv(setup);
  const code = await runClient(ELICITATION.words, run.env);
  return { code, stdout: run.stdout.join(""), stderr: run.stderr.join("") };
}

/** Живая форма без полей от сервера `gitlab`. */
async function gitlabForm(): Promise<string> {
  const live = JSON.parse(
    await readFile(
      new URL(
        "../../back/src/claudehook/testdata/elicitation/live-elicitation-mpu.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return JSON.stringify({
    ...live,
    mcp_server_name: "gitlab",
    message: "Удалить ветку?",
  });
}

it("сервер строк не отвечает — без решения, код 0", async () => {
  const base = `http://127.0.0.1:${await closedPort()}`;
  const seen = await viaClient({ base, main: "t", stdin: await gitlabForm() });
  expect([seen.code, seen.stdout]).toStrictEqual([0, ""]);
  assert(
    seen.stderr.startsWith(
      "mpu claude-hook elicitation: без решения — сервер mpu не отвечает: ",
    ),
    seen.stderr,
  );
});

it("11 через клиент: Accept из чата — решение в stdout, код 0", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const seen = viaClient({
        base: back.url,
        main: back.token,
        stdin: await gitlabForm(),
      });
      await bot.called(1);
      bot.deliver([pressUpdate(1, 111, bot.calls[0].data[0][0])]);
      expect(await seen).toStrictEqual({
        code: 0,
        stdout:
          '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{}}}\n',
        stderr: "",
      });
    },
    { questions: fakeQuestions(bot) },
  );
});
