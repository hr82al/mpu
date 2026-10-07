/**
 * Следующее событие сессии снимает её висящий вопрос о праве
 * (`claude-hook-permission-request.md`, «Решено в другом месте»; сценарии
 * досыла 2 порции R3). Строки-хуки идут через ядро, ключ сессии —
 * `CLAUDE_CODE_MESSAGING_SOCKET` клиента.
 */

import { readFile } from "node:fs/promises";
import { assert, describe, expect, it } from "vitest";
import {
  ELICITATION,
  NOTIFICATION,
  PERMISSION_REQUEST,
  SESSION_ENV,
  STOP,
} from "../frames/mod.ts";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
} from "../botquestions/testbot.ts";
import { Client, type TestBack, withBack, within } from "./testback.ts";

const SESSION_K = "/run/user/1000/cc-socks/k.sock";
const SESSION_L = "/run/user/1000/cc-socks/l.sock";

const TERMINAL_LINE = "\n✅ решено в терминале";

const EXPIRED_LINE = "\n⌛ истёк — ответьте в терминале";

/**
 * Право сессии K не снято: оборванная строка правит его в «истёк» —
 * а снятое уже было бы «решено в терминале».
 */
async function stillPending(bot: FakeBot, asked: Client): Promise<void> {
  asked.close();
  await within(
    (async () => {
      while (!edited(bot, 1546, EXPIRED_LINE)) {
        await bot.called(bot.calls.length + 1);
      }
    })(),
    5000,
    "право — в «истёк»",
  );
  expect(edited(bot, 1546, TERMINAL_LINE)).toBe(false);
}

async function testdata(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      new URL(`../claudehook/testdata/${path}`, import.meta.url),
      "utf8",
    ),
  );
}

/** Payload права на MCP-тул: транскрипта нет. */
async function permission(
  over: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  const live = await testdata("permission-request/live-permission-bash.json");
  return JSON.stringify({
    ...live,
    transcript_path: "/нет/транскрипта",
    ...over,
  });
}

/**
 * Payload уведомления вида `type`: `elicitation_dialog` — живой
 * (`fixtures/telegram-relay/r4/`), прочие — живой `idle_prompt` с
 * подменой вида.
 */
async function notification(type: string): Promise<string> {
  if (type === "elicitation_dialog") {
    return await readFile(
      new URL(
        "../../../docs/specs/fixtures/telegram-relay/r4/live-notification-elicitation-dialog.json",
        import.meta.url,
      ),
      "utf8",
    );
  }
  return JSON.stringify({
    ...(await testdata(
      "claude-hook-notification/live-payload-idle-prompt.json",
    )),
    notification_type: type,
  });
}

/** Строка-хук `words` сессии `session` с payload'ом `stdin`. */
async function hook(
  back: TestBack,
  words: readonly string[],
  stdin: string,
  session: string,
): Promise<Client> {
  const client = new Client(back, "/line");
  await client.opened();
  client.send({
    words,
    cwd: process.cwd(),
    human: false,
    stdin,
    env: { [SESSION_ENV]: session },
  });
  return client;
}

/** stderr строки-хука после её конца. */
async function stderrOf(client: Client): Promise<string> {
  const frames = await within(client.finished(), 5000, "строка хука");
  return frames.map((frame) => frame.err ?? "").join("");
}

/** Правка сообщения `message` строкой исхода `line`. */
function edited(bot: FakeBot, message: number, line: string): boolean {
  return bot.calls.some(
    (call) =>
      call.method === "edit" &&
      call.message === message &&
      call.text.endsWith(line),
  );
}

/** Право сессии K в чате: первое сообщение (1546). */
async function permissionOfK(back: TestBack, bot: FakeBot): Promise<Client> {
  const asked = await hook(
    back,
    PERMISSION_REQUEST.words,
    await permission(),
    SESSION_K,
  );
  await within(bot.called(1), 5000, "право в чате");
  return asked;
}

it("R3c-1: форма Elicitation сессии K снимает её право; форма — своим вопросом", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const asked = await permissionOfK(back, bot);
      const form = await hook(
        back,
        ELICITATION.words,
        JSON.stringify(
          await testdata("elicitation/live-elicitation-fields.json"),
        ),
        SESSION_K,
      );
      expect(await stderrOf(asked)).toStrictEqual(
        PERMISSION_REQUEST.undecided("решено в терминале"),
      );
      await within(bot.called(3), 5000, "право снято, форма показана");
      assert(edited(bot, 1546, TERMINAL_LINE), JSON.stringify(bot.calls));
      assert(
        bot.calls.some(
          (call) =>
            call.method === "send" && call.text.startsWith("📝 elicitprobe"),
        ),
        JSON.stringify(bot.calls),
      );
      form.close();
    },
    { questions: fakeQuestions(bot) },
  );
});

it("R3c-2: Stop сессии K снимает её право", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const asked = await permissionOfK(back, bot);
      const stop = await hook(
        back,
        STOP.words,
        JSON.stringify({
          ...(await testdata("stop/live-stop.json")),
          transcript_path: "/нет/транскрипта",
        }),
        SESSION_K,
      );
      expect(await stderrOf(asked)).toStrictEqual(
        PERMISSION_REQUEST.undecided("решено в терминале"),
      );
      assert(edited(bot, 1546, TERMINAL_LINE), JSON.stringify(bot.calls));
      await stderrOf(stop);
    },
    { questions: fakeQuestions(bot) },
  );
});

it("R3c-3: новое право сессии K снимает прежнее, новое — в чате", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const first = await permissionOfK(back, bot);
      const second = await hook(
        back,
        PERMISSION_REQUEST.words,
        await permission({ tool_input: { command: "ls /tmp" } }),
        SESSION_K,
      );
      expect(await stderrOf(first)).toStrictEqual(
        PERMISSION_REQUEST.undecided("решено в терминале"),
      );
      await within(bot.called(3), 5000, "второе право");
      assert(edited(bot, 1546, TERMINAL_LINE), JSON.stringify(bot.calls));
      assert(
        bot.calls.some(
          (call) => call.method === "send" && call.text.includes("ls /tmp"),
        ),
        JSON.stringify(bot.calls),
      );
      second.close();
    },
    { questions: fakeQuestions(bot) },
  );
});

describe("R3c-4: idle_prompt сессии K снимает право, permission_prompt — нет", () => {
  for (const [type, withdrawn] of [
    ["idle_prompt", true],
    ["elicitation_dialog", true],
    ["permission_prompt", false],
  ] as const) {
    it(type, async () => {
      const bot = new FakeBot();
      await withBack(
        async (back) => {
          const asked = await permissionOfK(back, bot);
          const note = await hook(
            back,
            NOTIFICATION.words,
            await notification(type),
            SESSION_K,
          );
          await within(note.finished(), 5000, "строка уведомления");
          if (withdrawn) {
            expect(await stderrOf(asked)).toStrictEqual(
              PERMISSION_REQUEST.undecided("решено в терминале"),
            );
            assert(edited(bot, 1546, TERMINAL_LINE), JSON.stringify(bot.calls));
            // Больше ничего: ни строки-уведомления, ни снимка — одно сообщение
            // права.
            expect(
              bot.calls.filter((call) => call.method === "send").length,
            ).toBe(1);
          } else {
            await stillPending(bot, asked);
          }
        },
        { questions: fakeQuestions(bot) },
      );
    });
  }
});

it("R3c-5: событие сессии L не трогает право сессии K", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const asked = await permissionOfK(back, bot);
      const stop = await hook(
        back,
        STOP.words,
        JSON.stringify({
          ...(await testdata("stop/live-stop.json")),
          transcript_path: "/нет/транскрипта",
        }),
        SESSION_L,
      );
      await stderrOf(stop);
      await within(bot.called(2), 5000, "«ждёт ввода» сессии L");
      await stillPending(bot, asked);
    },
    { questions: fakeQuestions(bot) },
  );
});

it("R3c-3: неразобранный PermissionRequest сессии K — тоже событие: прежнее право снято", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const asked = await permissionOfK(back, bot);
      const broken = await hook(back, PERMISSION_REQUEST.words, "{", SESSION_K);
      expect(await stderrOf(asked)).toStrictEqual(
        PERMISSION_REQUEST.undecided("решено в терминале"),
      );
      await stderrOf(broken);
    },
    { questions: fakeQuestions(bot) },
  );
});

it("R3c-5: форма сессии K в ряду — событие сессии её не снимает, ответ формы — решение", async () => {
  const bot = new FakeBot();
  await withBack(
    async (back) => {
      const form = await hook(
        back,
        ELICITATION.words,
        JSON.stringify({
          ...(await testdata("elicitation/live-elicitation-mpu.json")),
          mcp_server_name: "gitlab",
          message: "Удалить ветку?",
        }),
        SESSION_K,
      );
      await within(bot.called(1), 5000, "форма в чате");
      const stop = await hook(
        back,
        STOP.words,
        JSON.stringify({
          ...(await testdata("stop/live-stop.json")),
          transcript_path: "/нет/транскрипта",
        }),
        SESSION_K,
      );
      await stderrOf(stop);
      const accept = bot.calls[0].data[0][0];
      bot.deliver([pressUpdate(1, 111, accept)]);
      const frames = await within(form.finished(), 5000, "строка формы");
      expect(
        frames.filter((frame) => "out" in frame).map((frame) => frame.out),
      ).toStrictEqual([
        '{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{}}}\n',
      ]);
    },
    { questions: fakeQuestions(bot) },
  );
});
