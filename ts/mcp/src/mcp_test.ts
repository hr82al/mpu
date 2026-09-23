/**
 * Переводчик на проводе (`platform/mcp-objects.md`): два тула, итог —
 * тот же, что у `POST /agent/line`; вопрос — формой человеку; правила не
 * меняются; доступ — свой токен, 404 на неизвестную сессию.
 */

import { assertEquals } from "@std/assert";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { collected, post } from "../../back/src/backend/testback.ts";
import { ASK, RuleBook, RulePath } from "../../back/src/policy/mod.ts";
import { TOOLS } from "./mod.ts";
import {
  call,
  connect,
  type Elicit,
  MCP_TOKEN,
  type Stack,
  withClient,
  withStack,
} from "./testkit.ts";

const encoder = new TextEncoder();

Deno.test("описание тула mpu — текст v3 со словами грамматики из константы", async () => {
  const text = await Deno.readTextFile(
    new URL("testdata/mcp-objects/tool-desc-v3.txt", import.meta.url),
  );
  const mpu = TOOLS.find((tool) => tool.name === "mpu");
  assertEquals(mpu?.description, text.trimEnd());
});

Deno.test("tools/list — ровно help и mpu, схема — голден, описания ≤ 2048 байт", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      // Длина — первой: клиент режет описание молча, и это отдельное
      // свойство, а не частный случай сверки с голденом.
      for (const tool of TOOLS) {
        const bytes = encoder.encode(tool.description).length;
        assertEquals(bytes <= 2048, true, `${tool.name}: ${bytes} байт`);
      }
      const listed = await client.listTools();
      stack.seen.push(JSON.stringify(listed));
      const golden = JSON.parse(
        await Deno.readTextFile(
          new URL("testdata/mcp-objects/tools.json", import.meta.url),
        ),
      );
      assertEquals(listed, golden);
      assertEquals(
        listed.tools.map((tool: { name: string }) => tool.name),
        ["help", "mpu"],
      );
    })
  ));

/** Та же строка через `POST /agent/line` с основным токеном. */
async function direct(stack: Stack, words: readonly string[]) {
  return await collected(
    stack.back,
    await post(stack.back, "/agent/line", {
      words,
      cwd: Deno.cwd(),
      human: false,
    }, { accept: "application/json" }),
  );
}

Deno.test("mpu: version и kitn — итог равен POST /agent/line", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      const version = await call(stack, client, "mpu", { words: ["version"] });
      assertEquals(version.content, [{ type: "text", text: "0.1.0\n" }]);
      assertEquals(version.isError, false);
      assertEquals(version.structuredContent, await direct(stack, ["version"]));
      const kitn = await call(stack, client, "mpu", { words: ["kitn"] });
      assertEquals(kitn.content, [
        { type: "text", text: "" },
        {
          type: "text",
          text: "stderr:\nmpu: не понимает kitn; ближайшие: kiten\n",
        },
      ]);
      assertEquals(kitn.isError, true);
      assertEquals(kitn.structuredContent, await direct(stack, ["kitn"]));
    })
  ));

Deno.test("help: корень без path, группа по path", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      const root = await call(stack, client, "help", {});
      assertEquals(root.structuredContent, await direct(stack, ["help"]));
      const kiten = await call(stack, client, "help", { path: ["kiten"] });
      assertEquals(
        kiten.structuredContent,
        await direct(stack, ["kiten", "help"]),
      );
      const text = String(
        (kiten.content as { text: string }[])[0].text,
      );
      assertEquals(text.includes("mpu kiten"), true);
    })
  ));

Deno.test("mpu: пустые слова — -32602", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      for (const args of [{ words: [] }, { words: "version" }, {}]) {
        let code = 0;
        try {
          await client.callTool({ name: "mpu", arguments: args });
        } catch (err) {
          code = (err as { code?: number }).code ?? 0;
        }
        assertEquals(code, -32602, JSON.stringify(args));
      }
    })
  ));

Deno.test("правило через mcp не меняется, вопроса нет", () =>
  withStack(async (stack) => {
    const asked: ElicitRequest[] = [];
    await withClient(stack, async (client) => {
      await call(stack, client, "mpu", { words: ["version"] });
      const before = await Deno.readFile(stack.back.policyFile);
      const result = await call(stack, client, "mpu", {
        words: ["allow:", "kiten ls"],
      });
      assertEquals(result.isError, true);
      assertEquals(
        (result.content as { text: string }[])[1].text,
        "stderr:\nизменить правила может только человек\n",
      );
      assertEquals(await Deno.readFile(stack.back.policyFile), before);
    }, (request) => {
      asked.push(request);
      return { action: "accept", content: { confirm: true } };
    });
    assertEquals(asked, []);
  }));

function askOnAliases(stack: Stack) {
  using book = RuleBook.open(stack.back.policyFile, []);
  book.set(RulePath.parse("xlsx alias ls"), ASK);
}

const QUESTION = "выполнить mpu xlsx alias ls? [y/N] ";

Deno.test("вопрос формой: accept+true — исполнено, иначе — не подтверждено", async (t) => {
  const cases: readonly (readonly [string, Elicit, boolean])[] = [
    [
      "accept+true",
      () => ({ action: "accept", content: { confirm: true } }),
      true,
    ],
    [
      "accept+false",
      () => ({ action: "accept", content: { confirm: false } }),
      false,
    ],
    ["decline", () => ({ action: "decline" }), false],
    ["cancel", () => ({ action: "cancel" }), false],
  ];
  const golden = JSON.parse(
    await Deno.readTextFile(
      new URL("testdata/mcp-objects/elicitation.json", import.meta.url),
    ),
  );
  for (const [name, answer, runs] of cases) {
    await t.step(name, () =>
      withStack(async (stack) => {
        askOnAliases(stack);
        const asked: ElicitRequest[] = [];
        await withClient(stack, async (client) => {
          const result = await call(stack, client, "mpu", {
            words: ["ask", "xlsx", "alias", "ls"],
          });
          assertEquals(result.isError, !runs);
          if (!runs) {
            assertEquals(
              (result.content as { text: string }[])[1].text,
              "stderr:\nmpu xlsx alias ls: не подтверждено\n",
            );
          }
        }, (request) => {
          asked.push(request);
          return answer(request);
        });
        assertEquals(stack.back.called, runs ? ["xlsx alias ls"] : []);
        assertEquals(asked.length, 1);
        const form = golden.server_request.params;
        assertEquals(asked[0].params, {
          ...form,
          message: QUESTION,
        });
      }));
  }
  await t.step(
    "клиент без elicitation — спросить некого",
    () =>
      withStack(async (stack) => {
        askOnAliases(stack);
        await withClient(stack, async (client) => {
          const result = await call(stack, client, "mpu", {
            words: ["ask", "xlsx", "alias", "ls"],
          });
          assertEquals(result.isError, true);
          assertEquals(
            (result.content as { text: string }[])[1].text,
            "stderr:\nmpu xlsx alias ls: нужно подтверждение, а спросить некого\n",
          );
        });
        assertEquals(stack.back.called, []);
      }),
  );
});

Deno.test("ask-строка без двери — ошибка с подсказкой, формы нет", () =>
  withStack(async (stack) => {
    askOnAliases(stack);
    const asked: ElicitRequest[] = [];
    await withClient(stack, async (client) => {
      const result = await call(stack, client, "mpu", {
        words: ["xlsx", "alias", "ls"],
      });
      assertEquals(result.isError, true);
      assertEquals(
        (result.content as { text: string }[])[1].text,
        "stderr:\nmpu xlsx alias ls: требует подтверждения — " +
          "вызывай mpu ask xlsx alias ls\n",
      );
    }, (request) => {
      asked.push(request);
      return { action: "accept", content: { confirm: true } };
    });
    assertEquals(asked, []);
    assertEquals(stack.back.called, []);
  }));

Deno.test("доступ: неизвестная сессия — 404, чужой токен — 401, чужой Origin — 403", () =>
  withStack(async (stack) => {
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };
    const send = async (headers: Record<string, string>) => {
      const response = await fetch(stack.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(init),
      });
      stack.seen.push(await response.text());
      return response.status;
    };
    const mine = { Authorization: `Bearer ${MCP_TOKEN}` };
    assertEquals(
      await send({ ...mine, "mcp-session-id": crypto.randomUUID() }),
      404,
    );
    assertEquals(await send({}), 401);
    assertEquals(
      await send({ Authorization: `Bearer ${stack.back.token}` }),
      401,
    );
    assertEquals(
      await send({ Authorization: `Bearer ${stack.back.agentToken}` }),
      401,
    );
    assertEquals(await send({ Origin: "http://evil.localhost" }), 403);
    // Без сессии и не `initialize` — отказ SDK, сессия не заводится.
    assertEquals(await send(mine), 400);
    let refused = false;
    try {
      const client = await connect(stack.url, undefined, stack.back.token);
      await client.close();
    } catch {
      refused = true;
    }
    assertEquals(refused, true);
  }));

Deno.test("GET /health — жив, pid, без токена", () =>
  withStack(async (stack) => {
    const response = await fetch(stack.url.replace("/mcp", "/health"));
    const text = await response.text();
    stack.seen.push(text);
    assertEquals([response.status, JSON.parse(text)], [200, {
      ok: true,
      pid: Deno.pid,
    }]);
    const post = await fetch(stack.url.replace("/mcp", "/health"), {
      method: "POST",
    });
    await post.body?.cancel();
    assertEquals(post.status, 405);
  }));

Deno.test("it: прошлый результат — только своей сессии агента", () =>
  withStack((stack) =>
    withClient(stack, (first) =>
      withClient(stack, async (second) => {
        const stamp = await call(stack, first, "mpu", { words: ["jsdate"] });
        assertEquals(stamp.isError, false);
        const other = await call(stack, second, "mpu", { words: ["it"] });
        assertEquals(other.isError, true);
        assertEquals(other.content, [
          { type: "text", text: "" },
          {
            type: "text",
            text:
              "stderr:\nmpu it: нет прошлого результата у этого вызывающего\n",
          },
        ]);
        const own = await call(stack, first, "mpu", { words: ["it"] });
        assertEquals(own.content, stamp.content);
      }))
  ));
