/**
 * Доступ к `mpu-back` (`platform/back-rpc.md`, «Доступ»): здоровье без
 * токена, `Origin` раньше токена, токен в заголовке или подпротоколе,
 * неизвестный путь и чужой метод.
 */

import { assertEquals } from "@std/assert";
import { VERSION } from "../version.ts";
import { Client, request, withBack } from "./testback.ts";

const EVIL = { Origin: "http://evil.localhost" };

Deno.test("health без токена — 200 и версия", () =>
  withBack(async (back) => {
    const health = await request(back, "/health");
    assertEquals(health.status, 200);
    assertEquals(JSON.parse(health.body), { ok: true, version: VERSION });
  }));

Deno.test("rpc без токена — 401, с чужим Origin без токена — 403", () =>
  withBack(async (back) => {
    const rpc = {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "schema" }),
    };
    assertEquals(await request(back, "/rpc", rpc), { status: 401, body: "" });
    assertEquals(await request(back, "/rpc", { ...rpc, headers: EVIL }), {
      status: 403,
      body: "",
    });
    assertEquals(
      await request(back, "/rpc", {
        ...rpc,
        headers: { Authorization: "Bearer wrong" },
      }),
      { status: 401, body: "" },
    );
    assertEquals(
      await request(back, "/line", { headers: EVIL }),
      { status: 403, body: "" },
    );
  }));

Deno.test("путь неизвестен — 404, метод не тот — 405", () =>
  withBack(async (back) => {
    const auth = { Authorization: `Bearer ${back.token}` };
    assertEquals(await request(back, "/nope", { headers: auth }), {
      status: 404,
      body: "",
    });
    assertEquals(await request(back, "/rpc", { headers: auth }), {
      status: 405,
      body: "",
    });
    assertEquals(
      await request(back, "/health", { method: "POST", body: "" }),
      { status: 405, body: "" },
    );
  }));

Deno.test("WebSocket: Origin фронта и токен в подпротоколе — подключение", () =>
  withBack(async (back) => {
    const client = new Client(back, "/line", {
      headers: { Origin: "http://mpu.localhost:7338" },
    });
    await client.opened();
    assertEquals(client.protocol(), "mpu");
    client.start(["version"]);
    assertEquals(await client.finished(), [
      { out: `${VERSION}\n` },
      { exit: 0 },
    ]);
  }));

Deno.test("WebSocket без токена не подключается", () =>
  withBack(async (back) => {
    const client = new Client(back, "/line", { bearer: false });
    await client.opened();
    assertEquals(client.frames, []);
    await client.closed();
  }));

Deno.test("GET /line без upgrade — 400", () =>
  withBack(async (back) => {
    assertEquals(
      await request(back, "/line", {
        headers: { Authorization: `Bearer ${back.token}` },
      }),
      { status: 400, body: "" },
    );
  }));
