/**
 * Команда `mpu claude-hook notification`
 * (`docs/specs/claude-hook-notification.md`): отправка на подставном
 * сервере и рамка отказа разбора. Наружу тесты не ходят.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Command, CommandIo } from "../command/mod.ts";
import { formatCommandError, UsageError } from "../command/mod.ts";
import {
  claudeHookNotificationCommand,
  runNotification,
} from "./cmd_notification.ts";

const command: Command = claudeHookNotificationCommand;

/** Ключи бота: конфигурация читается уже после разбора stdin. */
const ENV: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN: "8123:AAH",
  TELEGRAM_BOT_ID: "987654321",
};

/** Порт команды: весь stdin и ключи env-файла. */
function io(stdin: string): Pick<CommandIo, "readStdin" | "envFile"> {
  return {
    readStdin: () => Promise.resolve(new TextEncoder().encode(stdin)),
    envFile: {
      get: (name: string) => ENV[name],
      require: (name: string) => ENV[name] ?? "",
      set: () => Promise.resolve(),
      values: () => ({ ...ENV }),
    },
  };
}

/** Сервер на петле: отдаёт ответ Bot API и записывает запрос. */
async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  try {
    await run(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`);
  } finally {
    await server.shutdown();
  }
}

/** Голден канала: копия лежит рядом с тестом. */
async function golden(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`./testdata/claude-hook-notification/${name}`, import.meta.url),
  );
}

Deno.test("payload уходит одним sendMessage, номер — в результат", async () => {
  let seenPath = "";
  let seenBody: unknown = null;
  let calls = 0;
  await withServer(
    async (request) => {
      calls += 1;
      seenPath = new URL(request.url).pathname;
      seenBody = await request.json();
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 5000001 } }),
      );
    },
    async (base) => {
      const result = await runNotification(
        io(JSON.stringify({
          session_id: "s-1",
          cwd: "/home/user/mr/mp/mpu",
          hook_event_name: "Notification",
          notification_type: "permission_prompt",
          notification_message: "разрешить Bash?",
        })),
        base,
      );
      assertEquals(result, { id: 5000001 });
    },
  );
  assertEquals(calls, 1);
  assertEquals(seenPath, "/bot8123:AAH/sendMessage");
  assertEquals(seenBody, {
    chat_id: 987654321,
    text: "Claude · mpu · permission_prompt\nразрешить Bash?",
  });
});

Deno.test("незнакомый тип уведомления доезжает, а не отбивается", async () => {
  await withServer(
    () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })),
    async (base) => {
      const result = await runNotification(
        io(JSON.stringify({ notification_type: "тип_из_будущего" })),
        base,
      );
      assertEquals(result, { id: 42 });
    },
  );
});

Deno.test("не-JSON stdin отбивается до сети", async () => {
  const err = await assertRejects(
    () =>
      runNotification(io("это не JSON"), "http://127.0.0.1:1/не-должно-быть"),
    UsageError,
  );
  assertEquals(
    `${formatCommandError(command.errorName, err)}\n`,
    await golden("err-bad-json-stderr.txt"),
  );
});

Deno.test("рендер результата — одна строка JSON голдена", async () => {
  assertEquals(
    command.renderResult({ id: 5000001 }, []),
    await golden("notify-stdout.txt"),
  );
});

Deno.test("команда объявлена подкомандой группы, мутирующей и без входов", () => {
  assertEquals(command.path, ["claude-hook", "notification"]);
  assertEquals(command.policy, "rw");
  assertEquals(command.errorName, "claude-hook notification");
  assertEquals(command.inputs, []);
});
