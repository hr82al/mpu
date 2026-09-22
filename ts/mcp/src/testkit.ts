/**
 * Для тестов переводчика: `mpu-back` и `mpu-mcp` в процессе теста, порты
 * от ОС, клиент того же SDK (умеет отвечать на elicitation). Сервер `back`
 * поднимается из `back/` только тестом: код `mcp/` берёт из `back/` лишь
 * контракт кадров.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type TestBack,
  withBack,
  within,
} from "../../back/src/backend/testback.ts";
import { BackLine, type Patience, serveMcp } from "./mod.ts";

export const MCP_TOKEN = "mcp-" + "t0ken-" + "value";

/** Недолгое ожидание `back` в тестах: 10 с спеки — параметр. */
export const QUICK: Patience = { deadlineMs: 300, everyMs: 20 };

/** Поднятые `back` и `mcp`. */
export interface Stack {
  readonly back: TestBack;
  readonly url: string;
  /** Всё, что переводчик отдал наружу, — для поиска токенов. */
  readonly seen: string[];
}

/** `back` и `mcp` на время `body`; остановка — в обратном порядке. */
export function withStack(
  body: (stack: Stack) => Promise<void>,
  setup: Parameters<typeof withBack>[1] & {
    /** Чем переводчик ходит в `back`: для записи его запросов. */
    readonly fetcher?: typeof fetch;
  } = {},
): Promise<void> {
  return withBack(async (back) => {
    const mcp = await serveMcp({
      port: 0,
      token: MCP_TOKEN,
      version: "0.1.0",
      back: new BackLine(
        { base: back.url, token: back.token, cwd: Deno.cwd() },
        QUICK,
        setup.fetcher,
      ),
    });
    const stack: Stack = {
      back,
      url: `http://127.0.0.1:${mcp.port}/mcp`,
      seen: [],
    };
    try {
      await body(stack);
    } finally {
      await within(mcp.stop(), 10_000, "остановка mpu-mcp");
    }
    for (const text of stack.seen) {
      for (const token of [MCP_TOKEN, back.token, back.agentToken]) {
        if (text.includes(token)) throw new Error(`токен в выводе: ${text}`);
      }
    }
  }, setup);
}

/** Как клиент отвечает на форму подтверждения; нет — клиент без elicitation. */
export type Elicit = (request: ElicitRequest) => ElicitResult;

/** Клиент SDK, подключённый к переводчику. */
export async function connect(
  url: string,
  elicit?: Elicit,
  token = MCP_TOKEN,
  /** Тела запросов клиента к переводчику: для голденов протокола. */
  record?: (body: string) => void,
): Promise<Client> {
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: elicit === undefined ? {} : { elicitation: {} } },
  );
  if (elicit !== undefined) {
    client.setRequestHandler(
      ElicitRequestSchema,
      (request: ElicitRequest) => elicit(request),
    );
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: record === undefined ? undefined : ((url, init) => {
      const body = init?.body;
      if (typeof body === "string") record(body);
      return fetch(url, init);
    }) as typeof fetch,
  });
  await client.connect(transport);
  return client;
}

/** Клиент на время `body`, закрывается до остановки сервера. */
export async function withClient(
  stack: Stack,
  body: (client: Client) => Promise<void>,
  elicit?: Elicit,
): Promise<void> {
  const client = await connect(stack.url, elicit);
  try {
    await body(client);
  } finally {
    await client.close();
  }
}

/** Вызов тула; ответ — в `seen`. */
export async function call(
  stack: Stack,
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  stack.seen.push(JSON.stringify(result));
  return result;
}
