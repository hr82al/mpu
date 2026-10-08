/**
 * Пары «запрос → ответ» из `fixtures/mcp-server/`, скопированные в
 * testdata: ядро проверяется поверх обработчика, без слушающего сокета
 * и без сети (`platform/mcp-server.md`, правила модуля).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  handleMcp,
  type McpRequest,
  type McpResponse,
  PROFILE_INSTRUCTIONS,
} from "./mod.ts";
import type { Command, CommandIo } from "@mpu/command";
import { makeDenoIo } from "../runtime/mod.ts";
import { commands } from "../registry/mod.ts";
import { NO_INVOKE_LOG } from "@mpu/invokelog";
import { makeFakeIo } from "@mpu/command/testing";

/** Фикстура спеки: класс, запрос и ожидаемый ответ. */
interface Fixture {
  readonly class: string;
  readonly request: McpRequest;
  readonly response: McpResponse;
}

async function fixture(name: string): Promise<Fixture> {
  const url = new URL(`testdata/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

function handle(
  request: McpRequest,
  io: CommandIo = makeFakeIo(),
  known: readonly Command[] = commands,
): Promise<McpResponse> {
  return handleMcp(request, {
    io,
    commands: known,
    version: "0.1.0",
    log: NO_INVOKE_LOG,
  });
}

/** Временный каталог с sample.xlsx: та же книга, что в golden xlsx. */
async function withSampleDir(fn: (dir: string) => Promise<void>) {
  const b64 = await readFile(
    new URL("../xlsx/testdata/sample.xlsx.b64", import.meta.url),
    "utf8",
  );
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await writeFile(
      `${dir}/sample.xlsx`,
      Uint8Array.from(
        atob(b64.replaceAll(/\s+/g, "")),
        (ch) => ch.codePointAt(0) ?? 0,
      ),
    );
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

it("server/discover: версии, возможности, идентичность, инструкции", async () => {
  const { request, response } = await fixture("discover-ok.json");
  const actual = await handle(request);
  expect(actual.status).toStrictEqual(response.status);
  expect(actual.headers["Content-Type"]).toBe("application/json");
  expect(actual.body).toStrictEqual(response.body);
});

it("tools/list: форма тула — эталон фикстуры", async () => {
  const { request, response } = await fixture("tools-list-ok.json");
  const actual = await handle(request);
  expect(actual.status).toBe(200);
  // Верхний уровень результата сверяется с эталоном целиком: иначе
  // конверт перечня в голдене не держит ни одна проверка.
  expect(envelopeOf(actual.body)).toStrictEqual(envelopeOf(response.body));
  // Состав растёт с переносом команд, поэтому сверяется форма записи
  // тула, а не байты списка (спека, «Golden-примеры»).
  const expected = toolByName(response.body, "xlsx_ls");
  const got = toolByName(actual.body, "xlsx_ls");
  expect(Object.keys(got).sort()).toStrictEqual(Object.keys(expected).sort());
  expect(got["title"]).toStrictEqual(expected["title"]);
  expect(got["annotations"]).toStrictEqual(expected["annotations"]);
  expect(shapeOf(got["inputSchema"])).toStrictEqual(
    shapeOf(expected["inputSchema"]),
  );
  expect(shapeOf(got["outputSchema"])).toStrictEqual(
    shapeOf(expected["outputSchema"]),
  );
});

it("tools/call: успех — структурное содержимое по схеме", async () => {
  const { request, response } = await fixture("tools-call-ok.json");
  await withSampleDir(async (dir) => {
    const real = makeDenoIo(dir);
    const actual = await handle(
      request,
      makeFakeIo({ readFile: real.readFile, cwd: () => dir }),
    );
    expect(actual.status).toBe(200);
    expect(actual.body).toStrictEqual(response.body);
  });
});

it("tools/call: аргумент не по схеме — JSON-RPC-ошибка", async () => {
  const { request, response } = await fixture("tools-call-invalid-args.json");
  const actual = await handle(request);
  expect(actual.status).toStrictEqual(response.status);
  expect(actual.body).toStrictEqual(response.body);
});

it("tools/call: доменная ошибка — результат с признаком ошибки", async () => {
  const { request, response } = await fixture("tools-call-domain-error.json");
  await withSampleDir(async (dir) => {
    const real = makeDenoIo(dir);
    const actual = await handle(
      request,
      makeFakeIo({ readFile: real.readFile, cwd: () => dir }),
    );
    expect(actual.status).toStrictEqual(response.status);
    expect(actual.body).toStrictEqual(withCwd(response.body, dir));
  });
});

it("Mcp-Name расходится с телом — 400 и код -32020", async () => {
  const { request, response } = await fixture("err-header-mismatch.json");
  const actual = await handle(request);
  expect(actual.status).toStrictEqual(response.status);
  expect(actual.body).toStrictEqual(response.body);
});

it("путь профиля принимает только POST", async () => {
  const { request, response } = await fixture("err-method-not-allowed.json");
  const actual = await handle(request);
  expect(actual.status).toStrictEqual(response.status);
  expect(actual.headers["Allow"]).toBe("POST");
  expect(actual.body).toStrictEqual(null);
});

it("неизвестный метод JSON-RPC — 404 и код -32601", async () => {
  const { request, response } = await fixture("err-unknown-method.json");
  const actual = await handle(request);
  expect(actual.status).toStrictEqual(response.status);
  expect(actual.body).toStrictEqual(response.body);
});

describe("границы, не покрытые фикстурами", () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  };
  const post = (path: string, body: unknown, headers: Record<string, string>) =>
    handle({ method: "POST", path, headers, body });

  it("путь не /ro и не /rw — 404 без тела", async () => {
    const actual = await post(
      "/tools",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      },
      { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    );
    expect(actual.status).toBe(404);
    expect(actual.body).toStrictEqual(null);
  });

  it("нотификация принята без тела ответа", async () => {
    const actual = await post(
      "/ro",
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "notifications/initialized",
      },
    );
    expect(actual.status).toBe(202);
    expect(actual.body).toStrictEqual(null);
  });

  it("нет обязательного заголовка — 400 и код -32020", async () => {
    const actual = await post(
      "/ro",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: meta },
      },
      { "MCP-Protocol-Version": "2026-07-28" },
    );
    expect(actual.status).toBe(400);
    expect(errorOf(actual.body).code).toBe(-32020);
  });

  it("заголовок в форме =?base64?…?= декодируется", async () => {
    const encoded = `=?base64?${btoa("tools/list")}?=`;
    const actual = await post(
      "/ro",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: meta },
      },
      {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": encoded,
      },
    );
    expect(actual.status).toBe(200);
  });

  it("версия протокола не поддержана — 400 и код -32022", async () => {
    const actual = await post(
      "/ro",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01" },
        },
      },
      { "MCP-Protocol-Version": "2030-01-01", "Mcp-Method": "tools/list" },
    );
    expect(actual.status).toBe(400);
    const error = errorOf(actual.body);
    expect(error.code).toBe(-32022);
    expect(error.data).toStrictEqual({
      supported: ["2026-07-28"],
      requested: "2030-01-01",
    });
  });

  it("тело не JSON-RPC-запрос — 400 без id", async () => {
    const actual = await post("/ro", ["не запрос"], {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    });
    expect(actual.status).toBe(400);
    expect(bodyRecord(actual.body)["id"]).toStrictEqual(null);
  });

  it("имя тула вне профиля — JSON-RPC-ошибка при 200", async () => {
    const actual = await post(
      "/ro",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "xlsx_open", arguments: {}, _meta: meta },
      },
      {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "xlsx_open",
      },
    );
    expect(actual.status).toBe(200);
    expect(errorOf(actual.body).message).toContain("xlsx_open");
  });

  it("неизвестное имя аргумента — ошибка ввода", async () => {
    const actual = await post(
      "/ro",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "xlsx_ls", arguments: { nope: 1 }, _meta: meta },
      },
      {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "xlsx_ls",
      },
    );
    expect(actual.status).toBe(200);
    expect(errorOf(actual.body).code).toBe(-32602);
    expect(errorOf(actual.body).message).toContain(`unknown argument`);
  });

  it("tools/call без Mcp-Name — 400 и код -32020", async () => {
    const actual = await post(
      "/ro",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "xlsx_ls", arguments: {}, _meta: meta },
      },
      {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
      },
    );
    expect(actual.status).toBe(400);
    expect(errorOf(actual.body).code).toBe(-32020);
  });

  it("tools/call без имени тула в теле — ошибка ввода", async () => {
    const actual = await post(
      "/ro",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { arguments: {}, _meta: meta },
      },
      {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "xlsx_ls",
      },
    );
    expect(actual.status).toBe(200);
    expect(errorOf(actual.body).code).toBe(-32602);
  });

  it("сбой реализации — внутренняя ошибка, не итог", async () => {
    const broken = makeFakeIo({
      openCacheDb: () => {
        throw new Error("хранилище недоступно");
      },
    });
    const actual = await handle(
      {
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
      },
      broken,
    );
    expect(actual.status).toBe(200);
    expect(errorOf(actual.body).code).toBe(-32603);
    expect(errorOf(actual.body).message).toContain("хранилище недоступно");
  });

  describe("тело без признаков JSON-RPC — 400", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["нет версии протокола", { id: 1, method: "tools/list" }],
      ["метод не строка", { jsonrpc: "2.0", id: 1, method: 7 }],
      [
        "идентификатор не скаляр",
        { jsonrpc: "2.0", id: { n: 1 }, method: "tools/list" },
      ],
    ];
    for (const [title, body] of cases) {
      it(title, async () => {
        const actual = await post("/ro", body, {
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        });
        expect(actual.status).toBe(400);
        expect(bodyRecord(actual.body)["id"]).toStrictEqual(null);
      });
    }
  });

  it("профиль rw публикует мутирующие тулы", async () => {
    const actual = await post(
      "/rw",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: meta },
      },
      { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    );
    expect(actual.status).toBe(200);
    expect(toolNames(actual.body).includes("xlsx_open")).toBe(true);
  });
});

describe("классическое рукопожатие: клиент старой ревизии", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handle({ method: "POST", path: "/ro", headers, body });

  it("initialize без заголовков — версия, identity, инструкции", async () => {
    const actual = await post({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-code", version: "2.1.223" },
      },
    });
    expect(actual.status).toBe(200);
    // Результат сверяется целиком, а не по полям: конверт текущей
    // ревизии в ответе `initialize` не появляется, и лишнее поле
    // видно только полным сравнением.
    const result = resultOf(actual.body);
    expect(result).toStrictEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mpu", version: "0.1.0" },
      instructions: PROFILE_INSTRUCTIONS["ro"],
    });
  });

  it("initialize с незнакомой версией — ответ версией по умолчанию", async () => {
    const actual = await post({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2023-01-01" },
    });
    const result = bodyRecord(bodyRecord(actual.body)["result"]);
    expect(result["protocolVersion"]).toBe("2025-06-18");
  });

  it("tools/list со старой версией в заголовке, без Mcp-Method", async () => {
    const actual = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "MCP-Protocol-Version": "2025-06-18" },
    );
    expect(actual.status).toBe(200);
    expect(toolNames(actual.body).includes("xlsx_ls")).toBe(true);
  });

  it("tools/call без Mcp-заголовков доходит до исполнения", async () => {
    const actual = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "xlsx_ls", arguments: { nope: 1 } },
    });
    expect(actual.status).toBe(200);
    // Ошибка ввода, а не отказ по заголовкам: вызов дошёл до тула.
    expect(errorOf(actual.body).code).toBe(-32602);
  });

  it("ping — пустой результат", async () => {
    const actual = await post({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(actual.status).toBe(200);
    expect(bodyRecord(actual.body)["result"]).toStrictEqual({});
  });

  it("неизвестный метод — 404 и код -32601", async () => {
    const actual = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "resources/list",
    });
    expect(actual.status).toBe(404);
    expect(errorOf(actual.body).code).toBe(-32601);
  });
});

/**
 * Конверт результата (`platform/mcp-server.md`, «Конверт результата»).
 * Каждый метод проверяется поимённо: признак полноты, найденный у
 * одного результата, ничего не говорит об остальных, а клиент бракует
 * без него весь ответ.
 */
describe("конверт результата", () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  };
  const listing = (path: string) =>
    handle({
      method: "POST",
      path,
      headers: {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: meta },
      },
    });

  it("tools/list на /ro — полнота, срок годности, область", async () => {
    assertListingEnvelope(resultOf((await listing("/ro")).body));
  });

  it("tools/list на /rw — тот же конверт", async () => {
    assertListingEnvelope(resultOf((await listing("/rw")).body));
  });

  it("tools/list классического рукопожатия — тот же конверт", async () => {
    const actual = await handle({
      method: "POST",
      path: "/ro",
      headers: {},
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    assertListingEnvelope(resultOf(actual.body));
  });

  it("tools/call классического рукопожатия — полнота без срока", async () => {
    await withSampleDir(async (dir) => {
      const real = makeDenoIo(dir);
      const actual = await handle(
        {
          method: "POST",
          path: "/ro",
          headers: {},
          body: {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "xlsx_ls", arguments: { file: "sample.xlsx" } },
          },
        },
        makeFakeIo({ readFile: real.readFile, cwd: () => dir }),
      );
      const result = resultOf(actual.body);
      expect(result["resultType"]).toBe("complete");
      // Срок годности и область кэша принадлежат перечню: у вызова тула
      // их нет вовсе, а не «нулевые».
      expect(Object.keys(result).sort()).toStrictEqual([
        "content",
        "resultType",
        "structuredContent",
      ]);
    });
  });

  it("два tools/list подряд — тела совпадают побитово", async () => {
    const first = await listing("/ro");
    const second = await listing("/ro");
    expect(JSON.stringify(first.body)).toStrictEqual(
      JSON.stringify(second.body),
    );
  });
});

/** Конверт результата-перечня: постоянные значения, а не «какие-нибудь». */
function assertListingEnvelope(result: Readonly<Record<string, unknown>>) {
  expect(result["resultType"]).toBe("complete");
  expect(result["ttlMs"]).toBe(0);
  expect(result["cacheScope"]).toBe("private");
}

/** Результат `tools/list` без самого списка: конверт перечня как есть. */
function envelopeOf(body: unknown): Readonly<Record<string, unknown>> {
  const { tools: _tools, ...envelope } = resultOf(body);
  return envelope;
}

/** Результат ответа как словарь; ответа с ошибкой здесь быть не должно. */
function resultOf(body: unknown): Readonly<Record<string, unknown>> {
  return bodyRecord(bodyRecord(body)["result"]);
}

/** Тело ответа как словарь; иначе — падение с читаемым сообщением. */
function bodyRecord(body: unknown): Readonly<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`ожидался объект тела, получено ${JSON.stringify(body)}`);
  }
  return { ...body };
}

function errorOf(body: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
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
