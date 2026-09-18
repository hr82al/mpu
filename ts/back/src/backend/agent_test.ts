/**
 * Агентский токен (`platform/back-rpc.md`, «Доступ»; `cli-client.md`,
 * «Канал и токен»): пускает на канал агента и в `/rpc`, на `/line` — 401,
 * и слову «я человек» с ним сервер не верит.
 */

import { assertEquals } from "@std/assert";
import { ASK, RuleBook, RulePath } from "../policy/mod.ts";
import { Client, request, type TestBack, withBack } from "./testback.ts";

function askOn(back: TestBack, path: string) {
  using book = RuleBook.open(back.policyFile, []);
  book.set(RulePath.parse(path), ASK);
}

Deno.test("агентский токен: /line — 401, /rpc — принят", () =>
  withBack(async (back) => {
    const agent = { Authorization: `Bearer ${back.agentToken}` };
    assertEquals(await request(back, "/line", { headers: agent }), {
      status: 401,
      body: "",
    });
    // Без Upgrade: доступ есть, но это не WebSocket.
    assertEquals(
      (await request(back, "/agent/line", { headers: agent })).status,
      400,
    );
    const rpc = await request(back, "/rpc", {
      method: "POST",
      headers: agent,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "policy.list" }),
    });
    assertEquals(rpc.status, 200);
    assertEquals("result" in JSON.parse(rpc.body), true);
  }));

Deno.test("агентский токен в подпротоколе /line не открывает", () =>
  withBack(async (back) => {
    const client = new Client(back, "/line", { agent: true });
    await client.opened();
    assertEquals(await client.closed() !== 1000, true);
    assertEquals(client.frames, []);
  }));

Deno.test("канал агента: human с агентским токеном не верится, с основным — да", () =>
  withBack(async (back) => {
    askOn(back, "xlsx alias ls");
    const byAgent = new Client(back, "/agent/line", {
      agent: true,
      answers: ["y"],
    });
    await byAgent.opened();
    byAgent.start(["xlsx", "alias", "ls"], true);
    assertEquals(await byAgent.finished(), [
      { err: "mpu xlsx alias ls: нужно подтверждение, а спросить некого\n" },
      { exit: 1 },
    ]);
    assertEquals(back.called, []);
    const byOwner = new Client(back, "/agent/line", { answers: ["y"] });
    await byOwner.opened();
    byOwner.start(["xlsx", "alias", "ls"], true);
    const frames = await byOwner.finished();
    assertEquals(frames[0], { ask: "выполнить mpu xlsx alias ls? [y/N] " });
    assertEquals(frames.at(-1), { exit: 0 });
    assertEquals(back.called, ["xlsx alias ls"]);
  }));
