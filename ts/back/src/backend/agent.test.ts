/**
 * Агентский токен (`platform/back-rpc.md`, «Доступ»; `cli-client.md`,
 * «Канал и токен»): пускает на канал агента и в `/rpc`, на `/line` — 401,
 * и слову «я человек» с ним сервер не верит.
 */

import { expect, it } from "vitest";
import { ASK, NOBODY_TO_ASK, RuleBook, RulePath } from "../policy/mod.ts";
import {
  Client,
  refusalFrame,
  request,
  type TestBack,
  withBack,
} from "./testback.ts";

function askOn(back: TestBack, path: string) {
  using book = RuleBook.open(back.policyFile, []);
  book.set(RulePath.parse(path), ASK);
}

it("агентский токен: /line — 401, /rpc — принят", () =>
  withBack(async (back) => {
    const agent = { Authorization: `Bearer ${back.agentToken}` };
    expect(await request(back, "/line", { headers: agent })).toStrictEqual({
      status: 401,
      body: "",
    });
    // Без Upgrade: доступ есть, но это не WebSocket.
    expect((await request(back, "/agent/line", { headers: agent })).status)
      .toBe(400);
    const rpc = await request(back, "/rpc", {
      method: "POST",
      headers: agent,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "policy.list" }),
    });
    expect(rpc.status).toBe(200);
    expect("result" in JSON.parse(rpc.body)).toBe(true);
  }));

it("агентский токен в подпротоколе /line не открывает", () =>
  withBack(async (back) => {
    const client = new Client(back, "/line", { agent: true });
    await client.opened();
    expect(await client.closed() !== 1000).toBe(true);
    expect(client.frames).toStrictEqual([]);
  }));

it("канал агента: human с агентским токеном не верится, с основным — да", () =>
  withBack(async (back) => {
    askOn(back, "xlsx alias ls");
    const byAgent = new Client(back, "/agent/line", {
      agent: true,
      answers: ["y"],
    });
    await byAgent.opened();
    byAgent.start(["ask", "xlsx", "alias", "ls"], true);
    expect(await byAgent.finished()).toStrictEqual([
      refusalFrame(NOBODY_TO_ASK, `mpu xlsx alias ls: ${NOBODY_TO_ASK}`),
      { err: "mpu xlsx alias ls: нужно подтверждение, а спросить некого\n" },
      { exit: 1 },
    ]);
    expect(back.called).toStrictEqual([]);
    const byOwner = new Client(back, "/agent/line", { answers: ["y"] });
    await byOwner.opened();
    byOwner.start(["ask", "xlsx", "alias", "ls"], true);
    const frames = await byOwner.finished();
    expect(frames[0]).toStrictEqual({
      ask: "выполнить mpu xlsx alias ls? [y/N] ",
    });
    expect(frames.at(-1)).toStrictEqual({ exit: 0 });
    expect(back.called).toStrictEqual(["xlsx alias ls"]);
  }));
