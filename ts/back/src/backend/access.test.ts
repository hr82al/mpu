/**
 * Доступ к `mpu-back` (`platform/back-rpc.md`, «Доступ»): здоровье без
 * токена, `Origin` раньше токена, токен в заголовке или подпротоколе,
 * неизвестный путь и чужой метод.
 */

import { expect, it } from "vitest";
import { VERSION } from "../version.ts";
import { Client, request, withBack } from "./testback.ts";

const EVIL = { Origin: "http://evil.localhost" };

it("health без токена — 200 и версия", () =>
  withBack(async (back) => {
    const health = await request(back, "/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toStrictEqual({
      ok: true,
      version: VERSION,
      pid: process.pid,
    });
  }));

it("rpc без токена — 401, с чужим Origin без токена — 403", () =>
  withBack(async (back) => {
    const rpc = {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "schema" }),
    };
    expect(await request(back, "/rpc", rpc)).toStrictEqual({
      status: 401,
      body: "",
    });
    expect(
      await request(back, "/rpc", { ...rpc, headers: EVIL }),
    ).toStrictEqual({
      status: 403,
      body: "",
    });
    expect(
      await request(back, "/rpc", {
        ...rpc,
        headers: { Authorization: "Bearer wrong" },
      }),
    ).toStrictEqual({ status: 401, body: "" });
    expect(await request(back, "/line", { headers: EVIL })).toStrictEqual({
      status: 403,
      body: "",
    });
  }));

it("путь неизвестен — 404, метод не тот — 405", () =>
  withBack(async (back) => {
    const auth = { Authorization: `Bearer ${back.token}` };
    // Путь без расширения — маршрут фронта (`specs/web.md`, «Статика»);
    // неизвестен путь с расширением вне `/assets`.
    expect(await request(back, "/nope.txt", { headers: auth })).toStrictEqual({
      status: 404,
      body: "",
    });
    expect(await request(back, "/rpc", { headers: auth })).toStrictEqual({
      status: 405,
      body: "",
    });
    expect(
      await request(back, "/health", { method: "POST", body: "" }),
    ).toStrictEqual({ status: 405, body: "" });
  }));

it("WebSocket: Origin фронта и токен в подпротоколе — подключение", () =>
  withBack(async (back) => {
    const client = new Client(back, "/line", {
      headers: { Origin: "http://mpu.localhost:7338" },
    });
    await client.opened();
    expect(client.protocol()).toBe("mpu");
    client.start(["version"]);
    expect(await client.finished()).toStrictEqual([
      { out: `${VERSION}\n` },
      { exit: 0 },
    ]);
  }));

it("WebSocket без токена не подключается", () =>
  withBack(async (back) => {
    const client = new Client(back, "/line", { bearer: false });
    await client.opened();
    expect(client.frames).toStrictEqual([]);
    await client.closed();
  }));

it("GET /line без upgrade — 400", () =>
  withBack(async (back) => {
    expect(
      await request(back, "/line", {
        headers: { Authorization: `Bearer ${back.token}` },
      }),
    ).toStrictEqual({ status: 400, body: "" });
  }));
