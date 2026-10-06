/**
 * Строка хука `Elicitation` через тонкий клиент
 * (`claude-hook-elicitation.md`, «CLI-контракт»): код 0 при любом исходе,
 * решение — в stdout, без решения — строка в stderr. Сервер из `back/`
 * поднимается только тестом.
 */

import { assert, assertEquals } from "@std/assert";
import { ELICITATION } from "../../back/src/frames/mod.ts";
import { withBack } from "../../back/src/backend/testback.ts";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
} from "../../back/src/botquestions/testbot.ts";
import { runClient } from "./client.ts";
import { testEnv } from "./testkit.ts";

/** Что увидел вызывающий клиента. */
interface Seen {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function viaClient(
  setup: { base: string; main?: string; stdin?: string },
): Promise<Seen> {
  const run = testEnv(setup);
  const code = await runClient(ELICITATION.words, run.env);
  return { code, stdout: run.stdout.join(""), stderr: run.stderr.join("") };
}

/** Живая форма без полей от сервера `gitlab`. */
async function gitlabForm(): Promise<string> {
  const live = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../back/src/claudehook/testdata/elicitation/live-elicitation-mpu.json",
        import.meta.url,
      ),
    ),
  );
  return JSON.stringify({
    ...live,
    mcp_server_name: "gitlab",
    message: "Удалить ветку?",
  });
}

Deno.test("сервер строк не отвечает — без решения, код 0", async () => {
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(closed.addr as Deno.NetAddr).port}`;
  closed.close();
  const seen = await viaClient({ base, main: "t", stdin: await gitlabForm() });
  assertEquals([seen.code, seen.stdout], [0, ""]);
  assert(
    seen.stderr.startsWith(
      "mpu claude-hook elicitation: без решения — сервер mpu не отвечает: ",
    ),
    seen.stderr,
  );
});

Deno.test("11 через клиент: Accept из чата — решение в stdout, код 0", async () => {
  const bot = new FakeBot();
  await withBack(async (back) => {
    const seen = viaClient({
      base: back.url,
      main: back.token,
      stdin: await gitlabForm(),
    });
    await bot.called(1);
    bot.deliver([pressUpdate(1, 111, bot.calls[0].data[0][0])]);
    assertEquals(await seen, {
      code: 0,
      stdout:
        '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{}}}\n',
      stderr: "",
    });
  }, { questions: fakeQuestions(bot) });
});
