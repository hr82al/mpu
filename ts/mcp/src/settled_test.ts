/**
 * Форма подтверждения снимается, когда вопрос решён в Telegram
 * (`platform/ask-telegram.md` [D.3], сценарий постановки R3 S5): переводчик
 * шлёт `notifications/cancelled` с `requestId` своей формы и продолжает
 * вызов. Форма обмена — голден `live-elicitation-cancel-exchange.jsonl`
 * (снят живьём 2026-10-06).
 */

import { assertEquals } from "@std/assert";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import {
  FakeBot,
  fakeQuestions,
  pressUpdate,
} from "../../back/src/botquestions/testbot.ts";
import { within } from "../../back/src/backend/testback.ts";
import { ASK, RuleBook, RulePath } from "../../back/src/policy/mod.ts";
import { call, connect, type Stack, withStack } from "./testkit.ts";
import { SETTLED_ELSEWHERE } from "./tools.ts";

/** Строки голдена обмена: `out` — что сервер послал клиенту. */
async function exchange(): Promise<{ out: Record<string, unknown> | null }[]> {
  const text = await Deno.readTextFile(
    new URL(
      "testdata/telegram-relay/live-elicitation-cancel-exchange.jsonl",
      import.meta.url,
    ),
  );
  return text.split("\n").filter((row) => row !== "").map((row) =>
    JSON.parse(row)
  );
}

function askOnAliases(stack: Stack) {
  using book = RuleBook.open(stack.back.policyFile, []);
  book.set(RulePath.parse("xlsx alias ls"), ASK);
}

Deno.test("S5: «Да» в чате — форма отменена с её requestId, вызов исполнен", async () => {
  const bot = new FakeBot();
  const golden = await exchange();
  const [, created, cancelled] = golden.map((row) => row.out);
  await withStack(async (stack) => {
    askOnAliases(stack);
    // Форма ждёт, пока её не снимут. Отмену видно на проводе, а не в
    // обработчике: клиент SDK отмену запроса с номером 0 пропускает
    // (`_oncancel` проверяет номер на ложность), и форма тестового
    // клиента снимается только его закрытием.
    const client = await connect(
      stack.url,
      (_request, extra) =>
        new Promise((_, reject) => {
          extra.signal.addEventListener(
            "abort",
            () => reject(extra.signal.reason),
            { once: true },
          );
        }),
    );
    // Что сервер шлёт клиенту — глазами транспорта, до разбора SDK.
    const received: JSONRPCMessage[] = [];
    const transport = client.transport;
    if (transport === undefined) throw new Error("клиент не подключён");
    const onmessage = transport.onmessage;
    transport.onmessage = (
      message: JSONRPCMessage,
      extra?: MessageExtraInfo,
    ) => {
      received.push(message);
      onmessage?.(message, extra);
    };
    try {
      const result = call(stack, client, "mpu", {
        words: ["ask", "xlsx", "alias", "ls"],
      });
      await within(bot.called(1), 5000, "вопрос в чате");
      const sent = bot.calls[0];
      bot.deliver([pressUpdate(1, 111, sent.data[0][0])]);
      assertEquals(
        (await within(result, 10_000, "итог вызова")).isError,
        false,
      );
    } finally {
      await client.close();
    }
    assertEquals(stack.back.called, ["xlsx alias ls"]);
    const form = received.find((message) =>
      "method" in message && message.method === "elicitation/create"
    );
    const cancel = received.find((message) =>
      "method" in message && message.method === "notifications/cancelled"
    );
    if (form === undefined || !("id" in form)) throw new Error("формы нет");
    // Поля — как у снятого обмена; причина и номер — свои.
    assertEquals(
      Object.keys(form).sort(),
      [
        ...Object.keys(created ?? {}),
        "jsonrpc",
      ].sort(),
    );
    assertEquals(cancel, {
      ...cancelled,
      jsonrpc: "2.0",
      params: { requestId: form.id, reason: SETTLED_ELSEWHERE },
    });
  }, { questions: fakeQuestions(bot) });
});

Deno.test("копия голдена обмена совпадает с каналом спецификаций", async () => {
  const read = (path: string) =>
    Deno.readTextFile(new URL(path, import.meta.url));
  assertEquals(
    await read(
      "testdata/telegram-relay/live-elicitation-cancel-exchange.jsonl",
    ),
    await read(
      "../../docs/specs/fixtures/telegram-relay/r3/live-elicitation-cancel-exchange.jsonl",
    ),
  );
});
