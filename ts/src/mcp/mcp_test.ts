/**
 * Пары «запрос → ответ» из `fixtures/mcp-server/`, скопированные в
 * testdata: ядро проверяется поверх обработчика, без слушающего сокета
 * и без сети (`platform/mcp-server.md`, правила модуля).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { handleMcp, type McpRequest, type McpResponse } from "./mod.ts";
import type { CommandIo } from "../command/mod.ts";
import { makeDenoIo } from "../runtime/mod.ts";
import { commands } from "../registry/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";

/** Фикстура спеки: класс, запрос и ожидаемый ответ. */
interface Fixture {
  readonly class: string;
  readonly request: McpRequest;
  readonly response: McpResponse;
}

async function fixture(name: string): Promise<Fixture> {
  const url = new URL(`testdata/${name}`, import.meta.url);
  return JSON.parse(await Deno.readTextFile(url));
}

function handle(
  request: McpRequest,
  io: CommandIo = makeFakeIo(),
): Promise<McpResponse> {
  return handleMcp(request, { io, commands, version: "0.1.0" });
}

/** Временный каталог с sample.xlsx: та же книга, что в golden xlsx. */
async function withSampleDir(fn: (dir: string) => Promise<void>) {
  const b64 = await Deno.readTextFile(
    new URL("../xlsx/testdata/sample.xlsx.b64", import.meta.url),
  );
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeFile(
      `${dir}/sample.xlsx`,
      Uint8Array.from(
        atob(b64.replaceAll(/\s+/g, "")),
        (ch) => ch.codePointAt(0) ?? 0,
      ),
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("server/discover: версии, возможности, идентичность, инструкции", async () => {
  const { request, response } = await fixture("discover-ok.json");
  const actual = await handle(request);
  assertEquals(actual.status, response.status);
  assertEquals(actual.headers["Content-Type"], "application/json");
  assertEquals(actual.body, response.body);
});

Deno.test("tools/list: форма тула — эталон фикстуры", async () => {
  const { request, response } = await fixture("tools-list-ok.json");
  const actual = await handle(request);
  assertEquals(actual.status, 200);
  // Состав растёт с переносом команд, поэтому сверяется форма записи
  // тула, а не байты списка (спека, «Golden-примеры»).
  const expected = toolByName(response.body, "xlsx_ls");
  const got = toolByName(actual.body, "xlsx_ls");
  assertEquals(Object.keys(got).sort(), Object.keys(expected).sort());
  assertEquals(got["title"], expected["title"]);
  assertEquals(got["annotations"], expected["annotations"]);
  assertEquals(shapeOf(got["inputSchema"]), shapeOf(expected["inputSchema"]));
  assertEquals(shapeOf(got["outputSchema"]), shapeOf(expected["outputSchema"]));
});

Deno.test("tools/call: успех — структурное содержимое по схеме", async () => {
  const { request, response } = await fixture("tools-call-ok.json");
  await withSampleDir(async (dir) => {
    const real = makeDenoIo(`${dir}/config.json`);
    const actual = await handle(
      request,
      makeFakeIo({ readFile: real.readFile, cwd: () => dir }),
    );
    assertEquals(actual.status, 200);
    assertEquals(actual.body, response.body);
  });
});

Deno.test("tools/call: аргумент не по схеме — JSON-RPC-ошибка", async () => {
  const { request, response } = await fixture("tools-call-invalid-args.json");
  const actual = await handle(request);
  assertEquals(actual.status, response.status);
  assertEquals(actual.body, response.body);
});

Deno.test("tools/call: доменная ошибка — результат с признаком ошибки", async () => {
  const { request, response } = await fixture("tools-call-domain-error.json");
  await withSampleDir(async (dir) => {
    const real = makeDenoIo(`${dir}/config.json`);
    const actual = await handle(
      request,
      makeFakeIo({ readFile: real.readFile, cwd: () => dir }),
    );
    assertEquals(actual.status, response.status);
    assertEquals(actual.body, withCwd(response.body, dir));
  });
});

Deno.test("Mcp-Name расходится с телом — 400 и код -32020", async () => {
  const { request, response } = await fixture("err-header-mismatch.json");
  const actual = await handle(request);
  assertEquals(actual.status, response.status);
  assertEquals(actual.body, response.body);
});

Deno.test("путь профиля принимает только POST", async () => {
  const { request, response } = await fixture("err-method-not-allowed.json");
  const actual = await handle(request);
  assertEquals(actual.status, response.status);
  assertEquals(actual.headers["Allow"], "POST");
  assertEquals(actual.body, null);
});

Deno.test("неизвестный метод JSON-RPC — 404 и код -32601", async () => {
  const { request, response } = await fixture("err-unknown-method.json");
  const actual = await handle(request);
  assertEquals(actual.status, response.status);
  assertEquals(actual.body, response.body);
});

Deno.test("границы, не покрытые фикстурами", async (t) => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  };
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    handle({ method: "POST", path, headers, body });

  await t.step("путь не /ro и не /rw — 404 без тела", async () => {
    const actual = await post("/tools", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" });
    assertEquals(actual.status, 404);
    assertEquals(actual.body, null);
  });

  await t.step("нотификация принята без тела ответа", async () => {
    const actual = await post("/ro", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "notifications/initialized",
    });
    assertEquals(actual.status, 202);
    assertEquals(actual.body, null);
  });

  await t.step("нет обязательного заголовка — 400 и код -32020", async () => {
    const actual = await post("/ro", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: meta },
    }, { "MCP-Protocol-Version": "2026-07-28" });
    assertEquals(actual.status, 400);
    assertEquals(errorOf(actual.body).code, -32020);
  });

  await t.step("заголовок в форме =?base64?…?= декодируется", async () => {
    const encoded = `=?base64?${btoa("tools/list")}?=`;
    const actual = await post("/ro", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: meta },
    }, {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": encoded,
    });
    assertEquals(actual.status, 200);
  });

  await t.step(
    "версия протокола не поддержана — 400 и код -32022",
    async () => {
      const actual = await post("/ro", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2024-11-05" },
        },
      }, { "MCP-Protocol-Version": "2024-11-05", "Mcp-Method": "tools/list" });
      assertEquals(actual.status, 400);
      const error = errorOf(actual.body);
      assertEquals(error.code, -32022);
      assertEquals(error.data, {
        supported: ["2026-07-28"],
        requested: "2024-11-05",
      });
    },
  );

  await t.step("тело не JSON-RPC-запрос — 400 без id", async () => {
    const actual = await post("/ro", ["не запрос"], {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    });
    assertEquals(actual.status, 400);
    assertEquals(bodyRecord(actual.body)["id"], null);
  });

  await t.step("имя тула вне профиля — JSON-RPC-ошибка при 200", async () => {
    const actual = await post("/ro", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "xlsx_open", arguments: {}, _meta: meta },
    }, {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "xlsx_open",
    });
    assertEquals(actual.status, 200);
    assertStringIncludes(errorOf(actual.body).message, "xlsx_open");
  });

  await t.step("неизвестное имя аргумента — ошибка ввода", async () => {
    const actual = await post("/ro", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "xlsx_ls", arguments: { nope: 1 }, _meta: meta },
    }, {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "xlsx_ls",
    });
    assertEquals(actual.status, 200);
    assertEquals(errorOf(actual.body).code, -32602);
    assertStringIncludes(errorOf(actual.body).message, `unknown argument`);
  });

  await t.step("tools/call без Mcp-Name — 400 и код -32020", async () => {
    const actual = await post("/ro", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "xlsx_ls", arguments: {}, _meta: meta },
    }, {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
    });
    assertEquals(actual.status, 400);
    assertEquals(errorOf(actual.body).code, -32020);
  });

  await t.step("tools/call без имени тула в теле — ошибка ввода", async () => {
    const actual = await post("/ro", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { arguments: {}, _meta: meta },
    }, {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "xlsx_ls",
    });
    assertEquals(actual.status, 200);
    assertEquals(errorOf(actual.body).code, -32602);
  });

  await t.step("сбой реализации — внутренняя ошибка, не итог", async () => {
    const broken = makeFakeIo({
      readConfigStore: () => Promise.reject(new Error("хранилище недоступно")),
    });
    const actual = await handle({
      method: "POST",
      path: "/ro",
      headers: {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "xlsx_ls",
      },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "xlsx_ls", arguments: {}, _meta: meta },
      },
    }, broken);
    assertEquals(actual.status, 200);
    assertEquals(errorOf(actual.body).code, -32603);
    assertStringIncludes(errorOf(actual.body).message, "хранилище недоступно");
  });

  await t.step("тело без признаков JSON-RPC — 400", async (inner) => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["нет версии протокола", { id: 1, method: "tools/list" }],
      ["метод не строка", { jsonrpc: "2.0", id: 1, method: 7 }],
      [
        "идентификатор не скаляр",
        { jsonrpc: "2.0", id: { n: 1 }, method: "tools/list" },
      ],
    ];
    for (const [title, body] of cases) {
      await inner.step(title, async () => {
        const actual = await post("/ro", body, {
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        });
        assertEquals(actual.status, 400);
        assertEquals(bodyRecord(actual.body)["id"], null);
      });
    }
  });

  await t.step("профиль rw публикует мутирующие тулы", async () => {
    const actual = await post("/rw", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: meta },
    }, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" });
    assertEquals(actual.status, 200);
    assertEquals(toolNames(actual.body).includes("xlsx_open"), true);
  });
});

/** Тело ответа как словарь; иначе — падение с читаемым сообщением. */
function bodyRecord(body: unknown): Readonly<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`ожидался объект тела, получено ${JSON.stringify(body)}`);
  }
  return { ...body };
}

function errorOf(
  body: unknown,
): { code: number; message: string; data?: unknown } {
  const error = bodyRecord(body)["error"];
  const record = bodyRecord(error);
  return {
    code: Number(record["code"]),
    message: String(record["message"]),
    data: record["data"],
  };
}

function toolsOf(body: unknown): readonly Readonly<Record<string, unknown>>[] {
  const tools = bodyRecord(bodyRecord(body)["result"])["tools"];
  if (!Array.isArray(tools)) throw new Error("в результате нет списка тулов");
  return tools.map((tool) => bodyRecord(tool));
}

function toolNames(body: unknown): readonly string[] {
  return toolsOf(body).map((tool) => String(tool["name"]));
}

function toolByName(
  body: unknown,
  name: string,
): Readonly<Record<string, unknown>> {
  const tool = toolsOf(body).find((item) => item["name"] === name);
  if (tool === undefined) throw new Error(`в списке нет тула ${name}`);
  return tool;
}

/**
 * Форма схемы: имена ключей на каждом уровне без значений описаний и
 * дефолтов — тексты принадлежат объявлению команды, а не эталону.
 * `minimum`/`maximum` целых полей тоже опущены: их дописывает
 * генератор JSON Schema (границы безопасного целого), команда их не
 * объявляет, и в фикстуре спеки их нет.
 */
function shapeOf(value: unknown): unknown {
  const ignored = ["description", "default", "minimum", "maximum"];
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value !== "object" || value === null) return typeof value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (ignored.includes(key)) continue;
    out[key] = shapeOf(item);
  }
  return out;
}

/**
 * Подставляет рабочий каталог в плейсхолдер `{{CWD}}` эталона: путь в
 * тексте доменной ошибки резолвлен командой и потому машинозависим
 * (спека, «Golden-примеры»).
 */
function withCwd(body: unknown, dir: string): unknown {
  return JSON.parse(JSON.stringify(body).replaceAll("{{CWD}}", dir));
}
