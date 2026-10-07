/**
 * Процесс `mpu-mcp` (`platform/mcp-objects.md`, «CLI-контракт»): адрес в
 * stdout, `mcp-token` 0600 при старте, остановка — 0, порт занят — 1;
 * новая команда `back` видна без перезапуска `mcp`.
 */

import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  type FakeHttp,
  listenLoopback,
  serveFetch,
} from "../../back/src/testing/http.ts";
import { runMcp, type TokenFile } from "./mod.ts";
import { MCP_TOKEN } from "./testkit.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function fileToken(path: string): TokenFile {
  return {
    path,
    read: async () => {
      try {
        return (await readFile(path, "utf8")).trim();
      } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
          return undefined;
        }
        throw err;
      }
    },
    write: async (token) => {
      await writeFile(path, `${token}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    },
  };
}

/** Фальшивый `back`: справка корня — из переданной строки. */
function fakeBack(help: () => string): Promise<FakeHttp> {
  return serveFetch(
    () =>
      new Response(JSON.stringify({ stdout: help(), stderr: "", exit: 0 }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
}

it("процесс: токен 0600, адрес, остановка, новая команда back без перезапуска", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const out: string[] = [];
  const err: string[] = [];
  let help = "команды: kiten\n";
  const back = await fakeBack(() => help);
  const stopped = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<string>();
  try {
    await writeFile(`${dir}/token`, "back-t0ken\n");
    const proc = {
      backUrl: back.baseUrl,
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
    expect(await runMcp(["--port", "x"], proc)).toBe(2);
    const running = runMcp(["--port", "0"], proc);
    const url = await listening.promise;
    const mode = (await stat(`${dir}/mcp-token`)).mode;
    expect(mode & 0o777).toBe(0o600);
    const token = (await readFile(`${dir}/mcp-token`, "utf8")).trim();
    expect(token === MCP_TOKEN).toBe(false);
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
    expect((first.content as { text: string }[])[0].text).toBe(
      "команды: kiten\n",
    );
    expect((second.content as { text: string }[])[0].text).toBe(
      "команды: kiten, новая\n",
    );
    stopped.resolve();
    expect(await running).toBe(0);
    expect(/^mpu-mcp: http:\/\/127\.0\.0\.1:\d+\/mcp\n$/.test(out[0])).toBe(
      true,
    );
    const printed = [...out, ...err, JSON.stringify([first, second])].join("");
    for (const secret of [token, "back-t0ken"]) {
      expect(printed.includes(secret)).toBe(false);
    }
  } finally {
    await back.stop();
    await rm(dir, { recursive: true });
  }
});

it("процесс: порт занят — 1, нет токена back — 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const busy = createServer();
  const port = await listenLoopback(busy);
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
    expect(await runMcp([], proc)).toBe(1);
    expect(err).toStrictEqual([
      `mpu-mcp: нет токена mpu-back (${dir}/token)\n`,
    ]);
    await writeFile(`${dir}/token`, "b\n");
    expect(await runMcp(["--port", String(port)], proc)).toBe(1);
    expect(err.at(-1)).toStrictEqual(`mpu-mcp: порт ${port} занят\n`);
  } finally {
    await new Promise((resolve) => busy.close(resolve));
    await rm(dir, { recursive: true });
  }
});

it("--version — версия, ни порта, ни токенов", async () => {
  const out: string[] = [];
  const untouched = {
    path: "/нет",
    read: () => Promise.reject(new Error("токен не читается")),
    write: () => Promise.reject(new Error("токен не пишется")),
  };
  const code = await runMcp(["--version"], {
    backUrl: "http://127.0.0.1:1",
    backToken: untouched,
    mcpToken: untouched,
    cwd: "/",
    version: "0.1.0",
    stdout: (text) => void out.push(text),
    stderr: () => {},
    stopped: Promise.resolve(),
  });
  expect([code, out]).toStrictEqual([0, ["0.1.0\n"]]);
});
