/**
 * Переводчик на проводе (`platform/mcp-objects.md`): два тула, итог —
 * тот же, что у `POST /agent/line`; вопрос — формой человеку; правила не
 * меняются; доступ — свой токен, 404 на неизвестную сессию.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type ElicitRequest,
  ElicitResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { collected, post } from "../../back/src/backend/testback.ts";
import { ALLOW, ASK, DENY, RuleBook, RulePath } from "@mpu/command/policy";
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
import elicitation from "./testdata/mcp-objects/elicitation.json" with {
  type: "json",
};

const encoder = new TextEncoder();

it("описание тула mpu — текст tool-desc со словами грамматики из константы", async () => {
  const text = await readFile(
    new URL("testdata/mcp-objects/tool-desc.txt", import.meta.url),
    "utf8",
  );
  const mpu = TOOLS.find((tool) => tool.name === "mpu");
  expect(mpu?.description).toStrictEqual(text.trimEnd());
});

it("tools/list — ровно help и mpu, схема — голден, описания ≤ 2048 байт", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      // Длина — первой: клиент режет описание молча, и это отдельное
      // свойство, а не частный случай сверки с голденом.
      for (const tool of TOOLS) {
        const bytes = encoder.encode(tool.description).length;
        expect(bytes <= 2048, `${tool.name}: ${bytes} байт`).toBe(true);
      }
      const listed = await client.listTools();
      stack.seen.push(JSON.stringify(listed));
      const golden = JSON.parse(
        await readFile(
          new URL("testdata/mcp-objects/tools.json", import.meta.url),
          "utf8",
        ),
      );
      expect(listed).toStrictEqual(golden);
      expect(
        listed.tools.map((tool: { name: string }) => tool.name),
      ).toStrictEqual(["help", "mpu"]);
    }),
  ));

/** Та же строка через `POST /agent/line` с основным токеном. */
async function direct(stack: Stack, words: readonly string[]) {
  return await collected(
    stack.back,
    await post(
      stack.back,
      "/agent/line",
      {
        words,
        cwd: process.cwd(),
        human: false,
      },
      { accept: "application/json" },
    ),
  );
}

it("mpu: version и kitn — итог равен POST /agent/line", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      const version = await call(stack, client, "mpu", { words: ["version"] });
      expect(version.content).toStrictEqual([
        {
          type: "text",
          text: "0.1.0\n",
        },
      ]);
      expect(version.isError).toBe(false);
      expect(version.structuredContent).toStrictEqual(
        await direct(stack, ["version"]),
      );
      const kitn = await call(stack, client, "mpu", { words: ["kitn"] });
      expect(kitn.content).toStrictEqual([
        { type: "text", text: "" },
        {
          type: "text",
          text: "stderr:\nmpu: не понимает kitn; ближайшие: kiten\n",
        },
      ]);
      expect(kitn.isError).toBe(true);
      expect(kitn.structuredContent).toStrictEqual(
        await direct(stack, ["kitn"]),
      );
    }),
  ));

/** Отказ-объект из ответа тула; у успешной строки его нет. */
function refusalOf(result: { structuredContent?: unknown }): unknown {
  const content = result.structuredContent as Record<string, unknown>;
  return content.refusal;
}

it("отказ — объект в structuredContent, hint — слова строки", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      const keyed = await call(stack, client, "mpu", {
        words: ["kiten", "comment", "55", "ok"],
      });
      expect(keyed.isError).toBe(true);
      expect(refusalOf(keyed)).toStrictEqual({
        reason: "значение — ключом",
        hint: ["kiten", "comment", "id:", "55", "text:", "ok"],
        candidates: [],
        text: "mpu kiten comment: значение — ключом: mpu kiten comment id: 55 text: ok",
      });
      const kitn = await call(stack, client, "mpu", { words: ["kitn"] });
      expect(refusalOf(kitn)).toStrictEqual({
        reason: "не понимает",
        hint: ["kiten"],
        candidates: ["kiten"],
        text: "mpu: не понимает kitn; ближайшие: kiten",
      });
      const door = await call(stack, client, "mpu", {
        words: ["sql", "target:", "1", "sql:", "update t"],
      });
      expect(door.isError).toBe(true);
      expect((refusalOf(door) as { hint: unknown }).hint).toStrictEqual([
        "ask",
        "sql",
        "target:",
        "1",
        "sql:",
        "update t",
      ]);
      const version = await call(stack, client, "mpu", { words: ["version"] });
      expect("refusal" in (version.structuredContent ?? {})).toBe(false);
    }),
  ));

it("отказ правил deny — hint null", () =>
  withStack((stack) => {
    {
      using book = RuleBook.open(stack.back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), DENY);
    }
    return withClient(stack, async (client) => {
      const denied = await call(stack, client, "mpu", {
        words: ["xlsx", "alias", "ls"],
      });
      expect(denied.isError).toBe(true);
      expect(refusalOf(denied)).toStrictEqual({
        reason: "запрещено правилом",
        hint: null,
        candidates: [],
        text: "mpu xlsx alias ls: запрещено правилом «xlsx alias ls»",
      });
    });
  }));

it("help: корень без path, группа по path", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      const root = await call(stack, client, "help", {});
      expect(root.structuredContent).toStrictEqual(
        await direct(stack, ["help"]),
      );
      const kiten = await call(stack, client, "help", { path: ["kiten"] });
      expect(kiten.structuredContent).toStrictEqual(
        await direct(stack, ["kiten", "help"]),
      );
      const text = String((kiten.content as { text: string }[])[0].text);
      expect(text.includes("mpu kiten")).toBe(true);
    }),
  ));

it("mpu: пустые слова — -32602", () =>
  withStack((stack) =>
    withClient(stack, async (client) => {
      for (const args of [{ words: [] }, { words: "version" }, {}]) {
        let code = 0;
        try {
          await client.callTool({ name: "mpu", arguments: args });
        } catch (err) {
          code = (err as { code?: number }).code ?? 0;
        }
        expect(code, JSON.stringify(args)).toBe(-32602);
      }
    }),
  ));

it("правило через mcp не меняется, вопроса нет", () =>
  withStack(async (stack) => {
    const asked: ElicitRequest[] = [];
    await withClient(
      stack,
      async (client) => {
        await call(stack, client, "mpu", { words: ["version"] });
        const before = await readFile(stack.back.policyFile);
        const result = await call(stack, client, "mpu", {
          words: ["allow:", "kiten ls"],
        });
        expect(result.isError).toBe(true);
        expect((result.content as { text: string }[])[1].text).toBe(
          "stderr:\nизменить правила может только человек\n",
        );
        expect(await readFile(stack.back.policyFile)).toStrictEqual(before);
      },
      (request) => {
        asked.push(request);
        return { action: "accept", content: {} };
      },
    );
    expect(asked).toStrictEqual([]);
  }));

function askOnAliases(stack: Stack) {
  using book = RuleBook.open(stack.back.policyFile, []);
  book.set(RulePath.parse("xlsx alias ls"), ASK);
}

/** Та же строка без вопроса — для сверки итога с `POST /agent/line`. */
function allowAliases(stack: Stack) {
  using book = RuleBook.open(stack.back.policyFile, []);
  book.set(RulePath.parse("xlsx alias ls"), ALLOW);
}

const QUESTION = "выполнить mpu xlsx alias ls? [y/N] ";

describe("вопрос формой: accept — исполнено, иначе — не подтверждено", () => {
  // Ответы клиента из голдена — схемой протокола: импорт JSON знает у
  // `action` только `string`.
  const replies = {
    accept: ElicitResultSchema.parse(
      elicitation.client_responses.accept.result,
    ),
    decline: ElicitResultSchema.parse(
      elicitation.client_responses.decline.result,
    ),
    escape: ElicitResultSchema.parse(
      elicitation.client_responses.escape.result,
    ),
  };
  const cases: readonly (readonly [string, Elicit, boolean])[] = [
    ["accept", () => replies.accept, true],
    ["accept без content", () => ({ action: "accept" }), true],
    // Старый клиент с флажком: содержимое не читается.
    [
      "accept+confirm:false",
      () => ({ action: "accept", content: { confirm: false } }),
      true,
    ],
    ["decline", () => replies.decline, false],
    ["cancel", () => replies.escape, false],
    [
      "ошибка запроса",
      () => {
        throw new Error("форма не показана");
      },
      false,
    ],
  ];
  for (const [name, answer, runs] of cases) {
    it(name, () =>
      withStack(async (stack) => {
        askOnAliases(stack);
        const asked: ElicitRequest[] = [];
        await withClient(
          stack,
          async (client) => {
            const result = await call(stack, client, "mpu", {
              words: ["ask", "xlsx", "alias", "ls"],
            });
            expect(result.isError).toStrictEqual(!runs);
            if (runs) {
              expect(stack.back.called).toStrictEqual(["xlsx alias ls"]);
              allowAliases(stack);
              expect(result.structuredContent).toStrictEqual(
                await direct(stack, ["xlsx", "alias", "ls"]),
              );
              return;
            }
            expect((result.content as { text: string }[])[1].text).toBe(
              "stderr:\nmpu xlsx alias ls: не подтверждено\n",
            );
            expect(stack.back.called).toStrictEqual([]);
          },
          (request, extra) => {
            asked.push(request);
            return answer(request, extra);
          },
        );
        expect(asked.length).toBe(1);
        const form = elicitation.server_request.params;
        expect(asked[0].params).toStrictEqual({
          ...form,
          message: QUESTION,
        });
      }),
    );
  }
  it("клиент без elicitation — спросить некого", () =>
    withStack(async (stack) => {
      askOnAliases(stack);
      await withClient(stack, async (client) => {
        const result = await call(stack, client, "mpu", {
          words: ["ask", "xlsx", "alias", "ls"],
        });
        expect(result.isError).toBe(true);
        expect((result.content as { text: string }[])[1].text).toBe(
          "stderr:\nmpu xlsx alias ls: нужно подтверждение, а спросить некого\n",
        );
      });
      expect(stack.back.called).toStrictEqual([]);
    }));
});

it("ask-строка без двери — ошибка с подсказкой, формы нет", () =>
  withStack(async (stack) => {
    askOnAliases(stack);
    const asked: ElicitRequest[] = [];
    await withClient(
      stack,
      async (client) => {
        const result = await call(stack, client, "mpu", {
          words: ["xlsx", "alias", "ls"],
        });
        expect(result.isError).toBe(true);
        expect((result.content as { text: string }[])[1].text).toStrictEqual(
          "stderr:\nmpu xlsx alias ls: требует подтверждения — " +
            "вызывай mpu ask xlsx alias ls\n",
        );
      },
      (request) => {
        asked.push(request);
        return { action: "accept", content: {} };
      },
    );
    expect(asked).toStrictEqual([]);
    expect(stack.back.called).toStrictEqual([]);
  }));

it("доступ: неизвестная сессия — 404, чужой токен — 401, чужой Origin — 403", () =>
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
    expect(await send({ ...mine, "mcp-session-id": crypto.randomUUID() })).toBe(
      404,
    );
    expect(await send({})).toBe(401);
    expect(await send({ Authorization: `Bearer ${stack.back.token}` })).toBe(
      401,
    );
    expect(
      await send({ Authorization: `Bearer ${stack.back.agentToken}` }),
    ).toBe(401);
    expect(await send({ Origin: "http://evil.localhost" })).toBe(403);
    // Без сессии и не `initialize` — отказ SDK, сессия не заводится.
    expect(await send(mine)).toBe(400);
    let refused = false;
    try {
      const client = await connect(stack.url, undefined, stack.back.token);
      await client.close();
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }));

it("GET /health — жив, pid, без токена", () =>
  withStack(async (stack) => {
    const response = await fetch(stack.url.replace("/mcp", "/health"));
    const text = await response.text();
    stack.seen.push(text);
    expect([response.status, JSON.parse(text)]).toStrictEqual([
      200,
      {
        ok: true,
        pid: process.pid,
      },
    ]);
    const post = await fetch(stack.url.replace("/mcp", "/health"), {
      method: "POST",
    });
    await post.body?.cancel();
    expect(post.status).toBe(405);
  }));

it("it: прошлый результат — только своей сессии агента", () =>
  withStack((stack) =>
    withClient(stack, (first) =>
      withClient(stack, async (second) => {
        const stamp = await call(stack, first, "mpu", { words: ["jsdate"] });
        expect(stamp.isError).toBe(false);
        const other = await call(stack, second, "mpu", { words: ["it"] });
        expect(other.isError).toBe(true);
        expect(other.content).toStrictEqual([
          { type: "text", text: "" },
          {
            type: "text",
            text: "stderr:\nmpu it: нет прошлого результата у этого вызывающего\n",
          },
        ]);
        const own = await call(stack, first, "mpu", { words: ["it"] });
        expect(own.content).toStrictEqual(stamp.content);
      }),
    ),
  ));
