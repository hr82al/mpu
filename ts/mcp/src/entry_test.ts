/**
 * Процесс `mpu-mcp` (`platform/mcp-objects.md`, «CLI-контракт»): адрес в
 * stdout, `mcp-token` 0600 при старте, остановка — 0, порт занят — 1;
 * новая команда `back` видна без перезапуска `mcp`.
 */

import { assertEquals } from "@std/assert";
import { runMcp, type TokenFile } from "./mod.ts";
import { MCP_TOKEN } from "./testkit.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function fileToken(path: string): TokenFile {
  return {
    path,
    read: async () => {
      try {
        return (await Deno.readTextFile(path)).trim();
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return undefined;
        throw err;
      }
    },
    write: async (token) => {
      await Deno.writeTextFile(path, `${token}\n`, { mode: 0o600 });
      await Deno.chmod(path, 0o600);
    },
  };
}

/** Фальшивый `back`: справка корня — из переданной строки. */
function fakeBack(help: () => string) {
  return Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      new Response(
        JSON.stringify({ stdout: help(), stderr: "", exit: 0 }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
}

Deno.test("процесс: токен 0600, адрес, остановка, новая команда back без перезапуска", async () => {
  const dir = await Deno.makeTempDir();
  const out: string[] = [];
  const err: string[] = [];
  let help = "команды: kiten\n";
  const back = fakeBack(() => help);
  const stopped = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<string>();
  try {
    await Deno.writeTextFile(`${dir}/token`, "back-t0ken\n");
    const proc = {
      backUrl: `http://127.0.0.1:${back.addr.port}`,
      backToken: fileToken(`${dir}/token`),
      mcpToken: fileToken(`${dir}/mcp-token`),
      cwd: dir,
      version: "0.1.0",
      stdout: (text: string) => {
        out.push(text);
        listening.resolve(text.trim().split(" ")[1]);
      },
      stderr: (text: string) => void err.push(text),
      stopped: stopped.promise,
    };
    assertEquals(await runMcp(["--port", "x"], proc), 2);
    const running = runMcp(["--port", "0"], proc);
    const url = await listening.promise;
    const mode = (await Deno.stat(`${dir}/mcp-token`)).mode ?? 0;
    assertEquals(mode & 0o777, 0o600);
    const token = (await Deno.readTextFile(`${dir}/mcp-token`)).trim();
    assertEquals(token === MCP_TOKEN, false);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const first = await client.callTool({ name: "help", arguments: {} });
    help = "команды: kiten, новая\n";
    const second = await client.callTool({ name: "help", arguments: {} });
    await client.close();
    assertEquals(
      (first.content as { text: string }[])[0].text,
      "команды: kiten\n",
    );
    assertEquals(
      (second.content as { text: string }[])[0].text,
      "команды: kiten, новая\n",
    );
    stopped.resolve();
    assertEquals(await running, 0);
    assertEquals(
      /^mpu-mcp: http:\/\/127\.0\.0\.1:\d+\/mcp\n$/.test(out[0]),
      true,
    );
    const printed = [...out, ...err, JSON.stringify([first, second])].join("");
    for (const secret of [token, "back-t0ken"]) {
      assertEquals(printed.includes(secret), false);
    }
  } finally {
    await back.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("процесс: порт занят — 1, нет токена back — 1", async () => {
  const dir = await Deno.makeTempDir();
  const busy = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const err: string[] = [];
  try {
    const proc = {
      backUrl: "http://127.0.0.1:1",
      backToken: fileToken(`${dir}/token`),
      mcpToken: fileToken(`${dir}/mcp-token`),
      cwd: dir,
      version: "0.1.0",
      stdout: () => {},
      stderr: (text: string) => void err.push(text),
      stopped: Promise.resolve(),
    };
    assertEquals(await runMcp([], proc), 1);
    assertEquals(err, [`mpu-mcp: нет токена mpu-back (${dir}/token)\n`]);
    await Deno.writeTextFile(`${dir}/token`, "b\n");
    const port = (busy.addr as Deno.NetAddr).port;
    assertEquals(await runMcp(["--port", String(port)], proc), 1);
    assertEquals(err.at(-1), `mpu-mcp: порт ${port} занят\n`);
  } finally {
    busy.close();
    await Deno.remove(dir, { recursive: true });
  }
});
