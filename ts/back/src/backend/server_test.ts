/**
 * Остановка, снимок дерева, запросы `/rpc` и процесс `mpu-back`
 * (`platform/back-rpc.md`).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { rulesOf } from "../next/mod.ts";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
import { NO_INVOKE_LOG } from "../invokelog/mod.ts";
import { makeDenoIo, secretText, tokenFile } from "../runtime/mod.ts";
import { VERSION } from "../version.ts";
import { runBack } from "./entry.ts";
import type { SnapshotFs } from "./mod.ts";
import { Client, request, type TestBack, withBack } from "./testback.ts";

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

Deno.test("остановка: открытая строка получает err и exit 1", () =>
  withBack(async (back) => {
    {
      using book = RuleBook.open(back.policyFile, []);
      book.set(RulePath.parse("xlsx alias ls"), ASK);
    }
    const open = new Client(back, "/line");
    await open.opened();
    open.start(["xlsx", "alias", "ls"]);
    await open.frame((frame) => "ask" in frame);
    await back.running.stop();
    assertEquals(await open.finished(), [
      { ask: "выполнить mpu xlsx alias ls? [y/N] " },
      { err: "mpu-back: остановлен\n" },
      { exit: 1 },
    ]);
    assertEquals(back.called, []);
  }));

Deno.test("снимок дерева: записан при старте и равен tree.snapshot", () =>
  withBack(async (back) => {
    const answer = JSON.parse((await call(back, "tree.snapshot")).body);
    const file = JSON.parse(await Deno.readTextFile(back.snapshotFile));
    assertEquals(file, answer.result);
    assertEquals(answer.result.version, VERSION);
    const nodes = answer.result.nodes;
    assertEquals(nodes[0].path, []);
    assertEquals(nodes[0].selectors.includes("allow:"), true);
    const card = nodes.find((node: { path: string[] }) =>
      node.path.join(" ") === "kiten card"
    );
    assertEquals(card.tail, "args");
    assertEquals(card.selectors, []);
    const kiten = nodes.find((node: { path: string[] }) =>
      node.path.join(" ") === "kiten"
    );
    assertEquals(kiten.tail, null);
    const paths = nodes.map((node: { path: string[] }) => node.path.join(" "));
    assertEquals(paths.indexOf("kiten") < paths.indexOf("kiten card"), true);
    const dir = back.snapshotFile.slice(0, back.snapshotFile.lastIndexOf("/"));
    const names = [...Deno.readDirSync(dir)].map((entry) => entry.name);
    assertEquals(names, ["tree.json"]);
  }));

Deno.test("снимок пишется во временный файл и переименовывается", async () => {
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
  assertEquals(steps, ["mkdir /x", "write temp", "rename temp /x/tree.json"]);
});

Deno.test("снимок не записан — строка диагностики, сервер работает", () =>
  withBack(async (back) => {
    assertEquals(back.diagnosed.length, 1);
    assertStringIncludes(
      back.diagnosed[0],
      "mpu-back: снимок дерева не записан: ",
    );
    assertEquals((await request(back, "/health")).status, 200);
  }, {
    snapshotFile: (dir) => {
      Deno.writeTextFileSync(`${dir}/file`, "");
      return `${dir}/file/tree.json`;
    },
  }));

Deno.test("rpc: схема, правила, ошибки", () =>
  withBack(async (back) => {
    const schema = JSON.parse((await call(back, "schema")).body);
    const golden = new URL("testdata/back-rpc/schema.json", import.meta.url);
    assertEquals(schema, {
      jsonrpc: "2.0",
      id: 7,
      result: JSON.parse(await Deno.readTextFile(golden)),
    });
    const rules = JSON.parse((await call(back, "policy.list")).body);
    assertEquals(rules.result, rulesOf(back.policyFile));
    assertEquals(JSON.parse((await call(back, "nope")).body), {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
    assertEquals(JSON.parse((await rpc(back, "{")).body), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }));

Deno.test("rpc: нотификация — 204, не сообщение — -32600", () =>
  withBack(async (back) => {
    assertEquals(
      await rpc(back, JSON.stringify({ jsonrpc: "2.0", method: "schema" })),
      { status: 204, body: "" },
    );
    assertEquals(JSON.parse((await rpc(back, "[1]")).body), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
  }));

Deno.test("rpc: сбой метода — -32603", () =>
  withBack(async (back) => {
    await Deno.writeTextFile(back.policyFile, "не SQLite ".repeat(100));
    const broken = JSON.parse((await call(back, "policy.list")).body);
    assertEquals(broken.error.code, -32603);
    assertStringIncludes(broken.error.message, "правила подтверждения: ");
  }));

/** Строка использования: она же ответ на «не число» у обоих флагов. */
const USAGE_LINE =
  "mpu-back: использование: deno task back [--port <число>] [--lines <число>]\n";

Deno.test("процесс: адрес в stdout, оба токена 0600, остановка — 0, порт занят — 1", async () => {
  const dir = await Deno.makeTempDir();
  const out: string[] = [];
  const err: string[] = [];
  const stopped = Promise.withResolvers<void>();
  const busy = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const proc = {
      io: makeDenoIo(dir),
      agentToken: tokenFile(`${dir}/agent-token`),
      log: NO_INVOKE_LOG,
      policyFile: `${dir}/policy.db`,
      snapshotFile: `${dir}/tree.json`,
      webSessions: secretText(`${dir}/web-sessions`),
      webRoot: `${dir}/web`,
      output: {
        stdout: (text: string) => void out.push(text),
        stderr: (text: string) => void err.push(text),
      },
      stopped: stopped.promise,
    };
    const port = (busy.addr as Deno.NetAddr).port;
    assertEquals(await runBack(["--port", String(port)], proc), 1);
    assertEquals(err, [`mpu-back: порт ${port} занят\n`]);
    assertEquals(await runBack(["--port", "x"], proc), 2);
    assertEquals(err.at(-1), USAGE_LINE);
    // Предел одновременности: «не число» — ошибка формы вызова, а
    // «число, но не годится» — свой отказ (`platform/line-concurrency.md`).
    assertEquals(await runBack(["--lines", "abc"], proc), 2);
    assertEquals(err.at(-1), USAGE_LINE);
    for (const value of ["0", "-3"]) {
      assertEquals(await runBack(["--lines", value], proc), 2);
      assertEquals(
        err.at(-1),
        "mpu-back: предел строк должен быть больше нуля\n",
      );
    }
    // --version — до токенов и порта: ничего не поднимается.
    const version: string[] = [];
    assertEquals(
      await runBack(["--version"], {
        ...proc,
        output: { stdout: (text) => void version.push(text), stderr() {} },
      }),
      0,
    );
    assertEquals(version, ["0.1.0\n"]);
    const running = runBack(["--port", "0"], {
      ...proc,
      output: {
        stdout: (text: string) => {
          out.push(text);
          stopped.resolve();
        },
        stderr: (text: string) => void err.push(text),
      },
    });
    assertEquals(await running, 0);
    assertEquals(out.length, 1);
    assertEquals(/^mpu-back: http:\/\/127\.0\.0\.1:\d+\n$/.test(out[0]), true);
    const tokens: string[] = [];
    for (const name of ["token", "agent-token"]) {
      const mode = (await Deno.stat(`${dir}/${name}`)).mode ?? 0;
      assertEquals(mode & 0o777, 0o600, name);
      tokens.push((await Deno.readTextFile(`${dir}/${name}`)).trim());
    }
    assertEquals(tokens[0] === tokens[1], false);
    for (const token of tokens) {
      assertEquals([...out, ...err].join("").includes(token), false);
    }
  } finally {
    busy.close();
    await Deno.remove(dir, { recursive: true });
  }
});
