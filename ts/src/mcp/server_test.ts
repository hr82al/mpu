/**
 * HTTP-транспорт: что доходит до ядра, а что отвергается до него
 * (`platform/mcp-server.md`, «Ввод/вывод» и «Граничные случаи»).
 *
 * Сервер поднимается на порту 0 и опрашивается настоящим `fetch`:
 * проверяется поверхность, которую увидит клиент, а не внутренний
 * вызов. Порт берётся фактически выданный — константа в тесте сделала
 * бы его флейки при параллельном прогоне.
 */

import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { commands } from "../registry/mod.ts";
import { NO_INVOKE_LOG } from "../invokelog/mod.ts";
import { makeFakeIo } from "../testing/mod.ts";
import { LOOPBACK, type RunningServer, serveMcp } from "./server.ts";
import { VERSION } from "../version.ts";

// Токен — ASCII: HTTP-заголовок обязан быть ByteString, а настоящий
// токен и есть base64url.
const TOKEN = "proba-tokena-K7x9";
const PROTOCOL = "2026-07-28";

/** Заголовки корректного запроса; тест перебивает нужные ему. */
function headers(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${TOKEN}`,
    "MCP-Protocol-Version": PROTOCOL,
    "Mcp-Method": "tools/list",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete base[name];
    else base[name] = value;
  }
  return base;
}

/** Тело запроса `tools/list` с версией протокола в `_meta`. */
function listBody(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL } },
    ...overrides,
  };
}

/** Поднимает сервер на свободном порту и гасит его после теста. */
async function withServer(
  fn: (call: Caller, server: RunningServer) => Promise<void>,
): Promise<void> {
  const server = await serveMcp({
    port: 0,
    profiles: ["ro", "rw"],
    token: TOKEN,
    deps: { io: makeFakeIo(), commands, version: VERSION, log: NO_INVOKE_LOG },
  });
  const call: Caller = (path, init = {}) =>
    fetch(`http://${LOOPBACK}:${server.port}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(listBody()),
      ...init,
    });
  try {
    await fn(call, server);
  } finally {
    await server.shutdown();
  }
}

type Caller = (path: string, init?: RequestInit) => Promise<Response>;

/** Тело ответа как ошибка JSON-RPC. */
async function errorOf(response: Response) {
  const body = await response.json();
  return {
    id: body.id,
    code: body.error?.code,
    message: String(body.error?.message ?? ""),
    data: body.error?.data,
  };
}

/**
 * Сервер с реестром, разошедшимся с закрытым списком публикации:
 * сборка тулов отказывает, и отказ обязан прийти клиенту в его
 * формате. Ближайший достижимый способ уронить обработчик.
 */
async function withBrokenRegistry(
  fn: (call: () => Promise<Response>) => Promise<void>,
): Promise<void> {
  const broken = commands.map((command) =>
    command.path.join(" ") === "xlsx ls"
      ? { ...command, policy: "rw" as const }
      : command
  );
  const server = await serveMcp({
    port: 0,
    profiles: ["ro"],
    token: TOKEN,
    deps: {
      io: makeFakeIo(),
      commands: broken,
      version: VERSION,
      log: NO_INVOKE_LOG,
    },
  });
  try {
    await fn(() =>
      fetch(`http://${LOOPBACK}:${server.port}/ro`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(listBody()),
      })
    );
  } finally {
    await server.shutdown();
  }
}

Deno.test("сокет слушает только петлю", async () => {
  await withServer((_call, server) => {
    assertEquals(server.hostname, LOOPBACK);
    assertNotEquals(server.port, 0);
    return Promise.resolve();
  });
});

Deno.test("путь профиля принимает только POST", async (t) => {
  await withServer(async (call) => {
    for (const method of ["GET", "DELETE"]) {
      await t.step(method, async () => {
        const response = await call("/ro", { method, body: null });
        assertEquals(response.status, 405);
        assertEquals(response.headers.get("Allow"), "POST");
        assertEquals(await response.text(), "");
      });
    }
  });
});

Deno.test("Origin: чужой отвергается, отсутствующий принимается", async (t) => {
  await withServer(async (call) => {
    await t.step("чужой источник — 403", async () => {
      const response = await call("/ro", {
        headers: headers({ Origin: "https://example.com" }),
      });
      assertEquals(response.status, 403);
      const error = await errorOf(response);
      assertEquals(error.id, null);
      assertStringIncludes(error.message, "example.com");
    });
    await t.step("свои хосты — проходят, схема и порт не важны", async () => {
      // Список фиксирован спекой: 127.0.0.1, localhost, [::1].
      const allowed = [
        `http://${LOOPBACK}:1234`,
        `https://${LOOPBACK}`,
        "http://localhost:5173",
        "https://localhost",
        "http://[::1]:8080",
      ];
      for (const origin of allowed) {
        const response = await call("/ro", { headers: headers({ origin }) });
        assertEquals(response.status, 200, `отвергнут свой Origin ${origin}`);
        await response.body?.cancel();
      }
    });
    await t.step("неразбираемое значение отвергается", async () => {
      // Значение без схемы источником не разбирается: отказ, а не
      // падение обработчика (заголовок обязан быть ASCII).
      const response = await call("/ro", {
        headers: headers({ Origin: "ne-istochnik-vovse" }),
      });
      assertEquals(response.status, 403);
      assertStringIncludes((await errorOf(response)).message, "ne-istochnik");
    });
    await t.step("похожий, но чужой хост отвергается", async () => {
      // Подстрока своего имени своим источником не делает.
      for (
        const origin of ["http://localhost.evil.com", "http://127.0.0.1.ru"]
      ) {
        const response = await call("/ro", { headers: headers({ origin }) });
        assertEquals(response.status, 403, `пропущен чужой Origin ${origin}`);
        await response.body?.cancel();
      }
    });
    await t.step("без Origin — проходит", async () => {
      const response = await call("/ro");
      assertEquals(response.status, 200);
      await response.body?.cancel();
    });
  });
});

Deno.test("авторизация обязательна", async (t) => {
  await withServer(async (call) => {
    await t.step("без заголовка — 401 без тела", async () => {
      const response = await call("/ro", {
        headers: headers({ Authorization: null }),
      });
      assertEquals(response.status, 401);
      assertEquals(await response.text(), "");
    });
    await t.step("неверный токен — 401 без тела", async () => {
      const response = await call("/ro", {
        headers: headers({ Authorization: "Bearer ne-tot-token" }),
      });
      assertEquals(response.status, 401);
      assertEquals(await response.text(), "");
    });
  });
});

Deno.test("обязательные заголовки: отсутствие — 400 и код -32020", async (t) => {
  // Отсутствие MCP-Protocol-Version здесь не случай: запрос без него —
  // классическое рукопожатие старой ревизии, а не нарушение текущей.
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["Mcp-Method", listBody()],
    ["Mcp-Name", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "xlsx_ls",
        arguments: {},
        _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL },
      },
    }],
  ];
  await withServer(async (call) => {
    for (const [name, body] of cases) {
      await t.step(name, async () => {
        // Полный набор заголовков для этого тела, из которого затем
        // убран ровно один проверяемый: снимать его последним, иначе
        // соседний ключ вернул бы его обратно.
        const sent = headers({
          "Mcp-Method": String(body["method"]),
          "Mcp-Name": "xlsx_ls",
        });
        delete sent[name];
        const response = await call("/ro", {
          headers: sent,
          body: JSON.stringify(body),
        });
        assertEquals(response.status, 400);
        const error = await errorOf(response);
        assertEquals(error.code, -32020);
        assertStringIncludes(error.message, name);
      });
    }
  });
});

Deno.test("обязательные заголовки: расхождение с телом — 400 и -32020", async (t) => {
  const callBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "xlsx_ls",
      arguments: {},
      _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL },
    },
  };
  await withServer(async (call) => {
    await t.step("Mcp-Method", async () => {
      const response = await call("/ro", {
        headers: headers({ "Mcp-Method": "tools/call" }),
      });
      assertEquals(response.status, 400);
      assertEquals((await errorOf(response)).code, -32020);
    });
    await t.step("Mcp-Name", async () => {
      const response = await call("/ro", {
        headers: headers({
          "Mcp-Method": "tools/call",
          "Mcp-Name": "xlsx_get",
        }),
        body: JSON.stringify(callBody),
      });
      assertEquals(response.status, 400);
      const error = await errorOf(response);
      assertEquals(error.code, -32020);
      assertStringIncludes(error.message, "xlsx_get");
    });
    await t.step("MCP-Protocol-Version", async () => {
      const response = await call("/ro", {
        headers: headers({ "MCP-Protocol-Version": "2025-01-01" }),
      });
      assertEquals(response.status, 400);
      assertEquals((await errorOf(response)).code, -32020);
    });
    await t.step("значение в форме =?base64?…?= декодируется", async () => {
      const encoded = `=?base64?${btoa("tools/list")}?=`;
      const response = await call("/ro", {
        headers: headers({ "Mcp-Method": encoded }),
      });
      assertEquals(response.status, 200);
      await response.body?.cancel();
    });
    await t.step("=?base64?…?= с чужим значением — расхождение", async () => {
      const encoded = `=?base64?${btoa("tools/call")}?=`;
      const response = await call("/ro", {
        headers: headers({ "Mcp-Method": encoded }),
      });
      assertEquals(response.status, 400);
      assertEquals((await errorOf(response)).code, -32020);
    });
  });
});

Deno.test("версия протокола не поддержана — 400 и код -32022", async () => {
  await withServer(async (call) => {
    const response = await call("/ro", {
      headers: headers({ "MCP-Protocol-Version": "2030-01-01" }),
      body: JSON.stringify(listBody({
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2030-01-01" },
        },
      })),
    });
    assertEquals(response.status, 400);
    const error = await errorOf(response);
    assertEquals(error.code, -32022);
    assertEquals(error.data, {
      supported: [PROTOCOL],
      requested: "2030-01-01",
    });
  });
});

Deno.test("классическое рукопожатие проходит транспорт", async () => {
  await withServer(async (call) => {
    const response = await call("/ro", {
      headers: headers({ "MCP-Protocol-Version": null, "Mcp-Method": null }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body["result"]["protocolVersion"], "2025-06-18");
  });
});

Deno.test("404 различается телом: чужой путь и чужой метод", async (t) => {
  await withServer(async (call) => {
    await t.step("путь не /ro и не /rw — без тела", async () => {
      const response = await call("/tools");
      assertEquals(response.status, 404);
      assertEquals(await response.text(), "");
    });
    await t.step("неизвестный метод JSON-RPC — тело с -32601", async () => {
      const response = await call("/ro", {
        headers: headers({ "Mcp-Method": "prompts/list" }),
        body: JSON.stringify(listBody({ method: "prompts/list" })),
      });
      assertEquals(response.status, 404);
      const error = await errorOf(response);
      assertEquals(error.code, -32601);
      assertStringIncludes(error.message, "prompts/list");
    });
  });
});

Deno.test("тело не разбирается как JSON — 400 без id", async () => {
  await withServer(async (call) => {
    const response = await call("/ro", { body: "{не json" });
    assertEquals(response.status, 400);
    assertEquals((await errorOf(response)).id, null);
  });
});

Deno.test("нотификация принята: 202 без тела", async () => {
  await withServer(async (call) => {
    const response = await call("/ro", {
      headers: headers({ "Mcp-Method": "notifications/initialized" }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    assertEquals(response.status, 202);
    assertEquals(await response.text(), "");
  });
});

Deno.test("успешный ответ приходит как application/json", async () => {
  await withServer(async (call) => {
    const response = await call("/ro");
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Content-Type"), "application/json");
    const body = await response.json();
    assertEquals(Array.isArray(body.result.tools), true);
  });
});

Deno.test("заголовки сессий и потоков игнорируются", async () => {
  await withServer(async (call) => {
    const response = await call("/ro", {
      headers: headers({
        "Mcp-Session-Id": "sessiya-kotoroy-net",
        "Last-Event-ID": "17",
      }),
    });
    assertEquals(response.status, 200);
    // Сессия не заводится: ответного идентификатора сессии тоже нет.
    assertEquals(response.headers.get("Mcp-Session-Id"), null);
    await response.body?.cancel();
  });
});

Deno.test("профили разведены путями и не пересекаются", async (t) => {
  await withServer(async (call) => {
    await t.step("/ro не публикует мутирующий тул", async () => {
      const response = await call("/ro");
      const names = (await response.json()).result.tools.map((
        tool: { name: string },
      ) => tool.name);
      assertEquals(names.includes("xlsx_open"), false);
    });
    await t.step("/rw публикует его", async () => {
      const response = await call("/rw");
      const names = (await response.json()).result.tools.map((
        tool: { name: string },
      ) => tool.name);
      assertEquals(names.includes("xlsx_open"), true);
    });
  });
});

Deno.test("поднятый профиль один — путь второго не отвечает", async () => {
  const server = await serveMcp({
    port: 0,
    profiles: ["ro"],
    token: TOKEN,
    deps: { io: makeFakeIo(), commands, version: VERSION, log: NO_INVOKE_LOG },
  });
  try {
    const response = await fetch(`http://${LOOPBACK}:${server.port}/rw`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(listBody()),
    });
    assertEquals(response.status, 404);
    assertEquals(await response.text(), "");
  } finally {
    await server.shutdown();
  }
});

Deno.test("сбой реализации — 500 с JSON-RPC-ошибкой, сервер жив", async () => {
  await withBrokenRegistry(async (call) => {
    const response = await call();
    assertEquals(response.status, 500);
    const error = await errorOf(response);
    assertEquals(error.code, -32603);
    assertStringIncludes(error.message, "расходится");
    // Процесс не упал: следующий запрос обслуживается тем же сервером.
    const again = await call();
    assertEquals(again.status, 500);
    await again.body?.cancel();
  });
});

Deno.test("ни один ответ не содержит токена доступа", async (t) => {
  await withServer(async (call) => {
    const probes: readonly [string, RequestInit][] = [
      ["/ro", {}],
      ["/rw", {}],
      ["/ro", {
        headers: headers({ "Mcp-Method": "server/discover" }),
        body: JSON.stringify(listBody({ method: "server/discover" })),
      }],
      ["/ro", { headers: headers({ Authorization: "Bearer ne-tot" }) }],
      ["/ro", { headers: headers({ Origin: "https://example.com" }) }],
      ["/ro", { body: "{не json" }],
      ["/net-takogo", {}],
    ];
    for (const [path, init] of probes) {
      const response = await call(path, init);
      const text = await response.text();
      assertEquals(
        text.includes(TOKEN),
        false,
        `токен утёк в ответ ${path} (${response.status})`,
      );
    }
  });

  await t.step("в том числе в ответе о сбое реализации", async () => {
    // Сообщение сбоя несёт текст исключения — проверяем, что вместе с
    // ним наружу не уходит секрет.
    await withBrokenRegistry(async (call) => {
      const response = await call();
      assertEquals(response.status, 500);
      assertEquals((await response.text()).includes(TOKEN), false);
    });
  });
});
