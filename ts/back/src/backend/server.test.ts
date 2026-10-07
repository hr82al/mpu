/**
 * Остановка, снимок дерева, запросы `/rpc` и процесс `mpu-back`
 * (`platform/back-rpc.md`).
 */

import { readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { listenLoopback } from "../testing/http.ts";
import { rulesOf } from "../line/mod.ts";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
import { NO_INVOKE_LOG } from "../invokelog/mod.ts";
import { makeDenoIo, secretText, tokenFile } from "../runtime/mod.ts";
import { VERSION } from "../version.ts";
import { runBack } from "./entry.ts";
import type { SnapshotFs } from "./mod.ts";
import { Client, request, type TestBack, withBack } from "./testback.ts";
import { MemoryLauncher, NO_MARKERS } from "../worker/mod.ts";

function rpc(back: TestBack, body: string) {
  return request(back, "/rpc", {
    method: "POST",
    headers: { Authorization: `Bearer ${back.token}` },
    body,
  });
}

function call(back: TestBack, method: string) {
  return rpc(back, JSON.stringify({ jsonrpc: "2.0", id: 7, method }));
}

it("остановка: открытая строка получает err и exit 1", () =>
  withBack(async (back) => {
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const open = new Client(back, "/line");
    await open.opened();
    open.start(["ask", "xlsx", "alias", "ls"]);
    await open.frame((frame) => "ask" in frame);
    await back.running.stop();
    expect(await open.finished()).toStrictEqual([
      { ask: "выполнить mpu xlsx alias ls? [y/N] " },
      { err: "mpu-back: остановлен\n" },
      { exit: 1 },
    ]);
    expect(back.called).toStrictEqual([]);
  }));

it("снимок дерева: записан при старте и равен tree.snapshot", () =>
  withBack(async (back) => {
    const answer = JSON.parse((await call(back, "tree.snapshot")).body);
    const file = JSON.parse(await readFile(back.snapshotFile, "utf8"));
    expect(file).toStrictEqual(answer.result);
    expect(answer.result.version).toStrictEqual(VERSION);
    const nodes = answer.result.nodes;
    expect(nodes[0].path).toStrictEqual([]);
    const selectors = (node: { messages: { selector: string }[] }) =>
      node.messages.map((line) => line.selector);
    expect(selectors(nodes[0]).includes("allow:")).toBe(true);
    const card = nodes.find(
      (node: { path: string[] }) => node.path.join(" ") === "kiten card",
    );
    expect(card.tail).toBe("args");
    expect(selectors(card)).toStrictEqual(["id:"]);
    expect(card.formats).toStrictEqual(["json", "md"]);
    const kiten = nodes.find(
      (node: { path: string[] }) => node.path.join(" ") === "kiten",
    );
    expect(kiten.tail).toStrictEqual(null);
    const paths = nodes.map((node: { path: string[] }) => node.path.join(" "));
    expect(paths.indexOf("kiten") < paths.indexOf("kiten card")).toBe(true);
    const dir = back.snapshotFile.slice(0, back.snapshotFile.lastIndexOf("/"));
    const names = readdirSync(dir);
    expect(names).toStrictEqual(["tree.json"]);
  }));

it("снимок пишется во временный файл и переименовывается", async () => {
  const steps: string[] = [];
  const fs: SnapshotFs = {
    mkdir: (dir) => {
      steps.push(`mkdir ${dir}`);
      return Promise.resolve();
    },
    writeTextFile: (path) => {
      steps.push(`write ${path.endsWith(".tmp") ? "temp" : path}`);
      return Promise.resolve();
    },
    rename: (from, to) => {
      steps.push(`rename ${from.endsWith(".tmp") ? "temp" : from} ${to}`);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  };
  await withBack(() => Promise.resolve(), {
    fs,
    snapshotFile: () => "/x/tree.json",
  });
  expect(steps).toStrictEqual([
    "mkdir /x",
    "write temp",
    "rename temp /x/tree.json",
  ]);
});

it("снимок не записан — строка диагностики, сервер работает", () =>
  withBack(
    async (back) => {
      expect(back.diagnosed.length).toBe(1);
      expect(back.diagnosed[0]).toContain(
        "mpu-back: снимок дерева не записан: ",
      );
      expect((await request(back, "/health")).status).toBe(200);
    },
    {
      snapshotFile: (dir) => {
        writeFileSync(`${dir}/file`, "");
        return `${dir}/file/tree.json`;
      },
    },
  ));

it("rpc: схема, правила, ошибки", () =>
  withBack(async (back) => {
    const schema = JSON.parse((await call(back, "schema")).body);
    const golden = new URL("testdata/back-rpc/schema.json", import.meta.url);
    expect(schema).toStrictEqual({
      jsonrpc: "2.0",
      id: 7,
      result: JSON.parse(await readFile(golden, "utf8")),
    });
    const rules = JSON.parse((await call(back, "policy.list")).body);
    expect(rules.result).toStrictEqual(rulesOf(back.policyFile));
    expect(JSON.parse((await call(back, "nope")).body)).toStrictEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
    expect(JSON.parse((await rpc(back, "{")).body)).toStrictEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }));

it("rpc: нотификация — 204, не сообщение — -32600", () =>
  withBack(async (back) => {
    expect(
      await rpc(back, JSON.stringify({ jsonrpc: "2.0", method: "schema" })),
    ).toStrictEqual({ status: 204, body: "" });
    expect(JSON.parse((await rpc(back, "[1]")).body)).toStrictEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
  }));

it("rpc: сбой метода — -32603", () =>
  withBack(async (back) => {
    await writeFile(back.policyFile, "не SQLite ".repeat(100));
    const broken = JSON.parse((await call(back, "policy.list")).body);
    expect(broken.error.code).toBe(-32603);
    expect(broken.error.message).toContain("правила подтверждения: ");
  }));

/** Строка использования: она же ответ на «не число» у обоих флагов. */
const USAGE_LINE =
  "mpu-back: использование: bun run back [--port <число>] [--lines <число>] " +
  "[--worker <путь>]\n";

it("процесс: адрес в stdout, оба токена 0600, остановка — 0, порт занят — 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  const out: string[] = [];
  const err: string[] = [];
  const stopped = Promise.withResolvers<void>();
  const busy = createServer();
  const port = await listenLoopback(busy);
  try {
    const io = makeDenoIo(dir);
    const programs: string[] = [];
    const proc = {
      io,
      agentToken: tokenFile(`${dir}/agent-token`),
      log: NO_INVOKE_LOG,
      policyFile: `${dir}/policy.db`,
      imageFile: `${dir}/image.db`,
      snapshotFile: `${dir}/tree.json`,
      webSessions: secretText(`${dir}/web-sessions`),
      webRoot: `${dir}/web`,
      output: {
        stdout: (text: string) => void out.push(text),
        stderr: (text: string) => void err.push(text),
      },
      stopped: stopped.promise,
      workers: {
        program: "/нет/mpu-worker",
        launcher: (program: string) => {
          programs.push(program);
          return new MemoryLauncher(io, 1, () => Date.now());
        },
        markers: NO_MARKERS,
      },
    };
    expect(await runBack(["--port", String(port)], proc)).toBe(1);
    expect(err).toStrictEqual([`mpu-back: порт ${port} занят\n`]);
    expect(await runBack(["--port", "x"], proc)).toBe(2);
    expect(err.at(-1)).toStrictEqual(USAGE_LINE);
    // Предел одновременности: «не число» — ошибка формы вызова, а
    // «число, но не годится» — свой отказ (`platform/line-concurrency.md`).
    expect(await runBack(["--lines", "abc"], proc)).toBe(2);
    expect(err.at(-1)).toStrictEqual(USAGE_LINE);
    for (const value of ["0", "-3"]) {
      expect(await runBack(["--lines", value], proc)).toBe(2);
      expect(err.at(-1)).toBe(
        "mpu-back: предел строк должен быть больше нуля\n",
      );
    }
    // --version — до токенов и порта: ничего не поднимается.
    const version: string[] = [];
    expect(
      await runBack(["--version"], {
        ...proc,
        output: { stdout: (text) => void version.push(text), stderr() {} },
      }),
    ).toBe(0);
    expect(version).toStrictEqual(["0.1.0\n"]);
    const running = runBack(["--port", "0", "--worker", "/мой/mpu-worker"], {
      ...proc,
      output: {
        stdout: (text: string) => {
          out.push(text);
          stopped.resolve();
        },
        stderr: (text: string) => void err.push(text),
      },
    });
    expect(await running).toBe(0);
    // Программа исполнителя: без флага — умолчание процесса, с ним — его.
    expect(programs).toStrictEqual(["/нет/mpu-worker", "/мой/mpu-worker"]);
    expect(out.length).toBe(1);
    expect(/^mpu-back: http:\/\/127\.0\.0\.1:\d+\n$/.test(out[0])).toBe(true);
    const tokens: string[] = [];
    for (const name of ["token", "agent-token"]) {
      const mode = (await stat(`${dir}/${name}`)).mode;
      expect(mode & 0o777, name).toBe(0o600);
      tokens.push((await readFile(`${dir}/${name}`, "utf8")).trim());
    }
    expect(tokens[0] === tokens[1]).toBe(false);
    for (const token of tokens) {
      expect([...out, ...err].join("").includes(token)).toBe(false);
    }
  } finally {
    busy.close();
    await rm(dir, { recursive: true });
  }
});
