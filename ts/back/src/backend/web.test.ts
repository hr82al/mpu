/**
 * Сторона фронта в `mpu-back` (`specs/web.md`, 10a): ключ входа только у
 * двери человека, сессия — cookie с точным `Origin`, в файле — только
 * хэши, `policy.tree` — решения того же набора правил, статика.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fakeTimers } from "../testing/scope.ts";
import { DatabaseSync } from "node:sqlite";
import { rulesOf } from "../line/mod.ts";
import { ALLOW, ASK, DENY, RuleBook, RulePath } from "../policy/mod.ts";
import { registrySeeds } from "../line/seeds.ts";
import { secretText } from "../runtime/mod.ts";
import {
  Client,
  collected,
  httpLine,
  ndjson,
  type TestBack,
  withBack,
} from "./testback.ts";
import { WebAccess } from "./web.ts";

const KEY = /^http:\/\/mpu\.localhost:(\d+)\/\?key=([0-9a-f]{32})\n$/;

const origin = (back: TestBack) =>
  `http://mpu.localhost:${new URL(back.url).port}`;

/** Строка по HTTP с основным токеном, собранным ответом. */
async function lineOf(back: TestBack, path: string, words: string[]) {
  return await collected(
    back,
    await fetch(`${back.url}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${back.token}`,
        Accept: "application/json",
      },
      body: JSON.stringify({ words, cwd: process.cwd() }),
    }),
  );
}

/** Ключ из ссылки `web`. */
async function key(back: TestBack): Promise<string> {
  const answer = await lineOf(back, "/line", ["web"]);
  const match = KEY.exec(String(answer.stdout));
  expect(match !== null, JSON.stringify(answer)).toBe(true);
  expect(match?.[1]).toStrictEqual(new URL(back.url).port);
  return match?.[2] ?? "";
}

/** Обмен ключа; ответ и значение cookie (если выдана). */
async function exchange(back: TestBack, value: string, from = origin(back)) {
  const response = await fetch(`${back.url}/web/session`, {
    method: "POST",
    headers: { Origin: from },
    body: JSON.stringify({ key: value }),
  });
  await response.body?.cancel();
  const cookie = response.headers.get("Set-Cookie") ?? "";
  return {
    status: response.status,
    cookie,
    session: /^mpu_session=([0-9a-f]{32});/.exec(cookie)?.[1] ?? "",
  };
}

async function session(back: TestBack): Promise<string> {
  const got = await exchange(back, await key(back));
  expect(got.status).toBe(204);
  return got.session;
}

/** `/rpc` с cookie и `Origin` (или без него). */
async function rpcWithCookie(
  back: TestBack,
  value: string,
  from: string | undefined,
) {
  const headers: Record<string, string> = { Cookie: `mpu_session=${value}` };
  if (from !== undefined) headers.Origin = from;
  const response = await fetch(`${back.url}/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "policy.list" }),
  });
  back.seen.push(await response.text());
  return response.status;
}

it("web — ссылка с ключом только у двери человека", () =>
  withBack(async (back) => {
    await key(back);
    expect(await lineOf(back, "/agent/line", ["web"])).toStrictEqual({
      stdout: "",
      stderr: "mpu: не понимает web; ближайшие: wb\n",
      exit: 2,
      // Кандидат — соседнее имя корня (`wb`, 173c), а не сама `web`:
      // агенту она по-прежнему не видна.
      refusal: {
        reason: "не понимает",
        hint: ["wb"],
        candidates: ["wb"],
        text: "mpu: не понимает web; ближайшие: wb",
      },
    });
    expect((await lineOf(back, "/agent/line", ["web-logout"])).exit).toBe(2);
  }));

it("ключ: 204 и cookie; второй раз — 404; чужой Origin — 403", () =>
  withBack(async (back) => {
    const value = await key(back);
    expect((await exchange(back, value, "http://evil.localhost")).status).toBe(
      403,
    );
    const first = await exchange(back, value);
    expect(first.status).toBe(204);
    expect(first.cookie).toStrictEqual(
      `mpu_session=${first.session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    expect((await exchange(back, value)).status).toBe(404);
  }));

it("ключ через 61 секунду — 404", async () => {
  fakeTimers();
  await withBack(async (back) => {
    const value = await key(back);
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await exchange(back, value)).status).toBe(404);
  });
});

it("cookie действует только при Origin страницы фронта", () =>
  withBack(async (back) => {
    const value = await session(back);
    expect(await rpcWithCookie(back, value, origin(back))).toBe(200);
    for (const from of [
      undefined,
      "http://localhost:5173",
      "http://mpu.localhost:9999",
    ]) {
      expect(await rpcWithCookie(back, value, from), String(from)).toBe(401);
    }
    expect(await rpcWithCookie(back, "0".repeat(32), origin(back))).toBe(401);
    // Сессия есть только в Set-Cookie ответа /web/session.
    expect(back.seen.some((text) => text.includes(value))).toBe(false);
    const agent = await fetch(`${back.url}/agent/line`, {
      method: "POST",
      headers: { Cookie: `mpu_session=${value}`, Origin: origin(back) },
      body: JSON.stringify({ words: ["version"], cwd: "/" }),
    });
    await agent.body?.cancel();
    expect(agent.status).toBe(401);
  }));

it("cookie: сокет /line и изменение правила через номер", () =>
  withBack(async (back) => {
    const value = await session(back);
    const headers = { Cookie: `mpu_session=${value}`, Origin: origin(back) };
    const socket = new Client(back, "/line", { headers, bearer: false });
    await socket.opened();
    socket.start(["version"]);
    expect((await socket.finished()).at(-1)).toStrictEqual({ exit: 0 });
    const allow = await fetch(`${back.url}/line`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        words: ["allow:", "kiten ls"],
        cwd: process.cwd(),
        human: true,
      }),
    });
    const asked = await ndjson(back, allow);
    const ticket = String(asked.at(-1)?.ticket);
    const answered = await fetch(`${back.url}/line/answer`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ticket, answer: "y" }),
    });
    expect((await ndjson(back, answered)).at(-1)).toStrictEqual({ exit: 0 });
    expect(
      rulesOf(back.policyFile).find((rule) => rule.path === "kiten ls"),
    ).toStrictEqual({ path: "kiten ls", verdict: "allow" });
  }));

it("файл сессий: 0600, только хэши, переживает перезапуск", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const file = `${dir}/web-sessions`;
    let value = "";
    await withBack(async (back) => {
      value = await session(back);
      const text = await readFile(back.webSessions, "utf8");
      expect(text.includes(value)).toBe(false);
      for (const row of text.split("\n").filter(Boolean)) {
        const stored = row.split(" ")[0];
        expect(await rpcWithCookie(back, stored, origin(back))).toBe(401);
      }
      const mode = (await stat(back.webSessions)).mode;
      expect(mode & 0o777).toBe(0o600);
      await copyFile(back.webSessions, file);
    });
    const reopened = await WebAccess.open({
      file: secretText(file),
      now: () => Date.now(),
    });
    expect(await reopened.admits(value)).toBe(true);
    expect(await reopened.admits("f".repeat(32))).toBe(false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("web-logout — число сессий, после — cookie 401", () =>
  withBack(async (back) => {
    const one = await session(back);
    await session(back);
    const out = await lineOf(back, "/line", ["web-logout"]);
    expect([out.stdout, out.exit]).toStrictEqual(["2\n", 0]);
    expect(await rpcWithCookie(back, one, origin(back))).toBe(401);
  }));

/** Набор «глубокая цепочка» эталона решений, посев снят. */
function deepChain(file: string) {
  using book = RuleBook.open(file, registrySeeds());
  for (const { path } of book.list()) book.forget(RulePath.parse(path));
  book.set(RulePath.parse("*"), DENY);
  book.set(RulePath.parse("kiten"), ASK);
  book.set(RulePath.parse("kiten card"), ALLOW);
}

async function tree(back: TestBack) {
  const response = await fetch(`${back.url}/rpc`, {
    method: "POST",
    headers: { Authorization: `Bearer ${back.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "policy.tree" }),
  });
  const body = await response.json();
  back.seen.push(JSON.stringify(body));
  return body.result as {
    path: string[];
    verdict: string;
    rule: string | null;
    own: boolean;
  }[];
}

it("policy.tree — голден на «глубокой цепочке»", () =>
  withBack(async (back) => {
    deepChain(back.policyFile);
    const golden = new URL("testdata/web/policy-tree.json", import.meta.url);
    expect(await tree(back)).toStrictEqual(
      JSON.parse(await readFile(golden, "utf8")),
    );
  }));

it("policy.tree после deny: kiten — kiten и потомки без своего правила", () =>
  withBack(async (back) => {
    const [, done] = await httpLine(
      back,
      "/line",
      {
        words: ["deny:", "kiten"],
        cwd: process.cwd(),
        human: true,
      },
      ["y"],
    );
    expect(done.at(-1)).toStrictEqual({ exit: 0 });
    const nodes = await tree(back);
    const own = new Set(rulesOf(back.policyFile).map((rule) => rule.path));
    for (const node of nodes.filter((one) => one.path[0] === "kiten")) {
      const path = node.path.join(" ");
      if (own.has(path)) continue;
      expect([node.verdict, node.rule], path).toStrictEqual(["deny", "kiten"]);
    }
    const kiten = nodes.find((one) => one.path.join(" ") === "kiten");
    expect(kiten).toStrictEqual({
      path: ["kiten"],
      verdict: "deny",
      rule: "kiten",
      own: true,
    });
    const card = nodes.find((one) => one.path.join(" ") === "kiten card");
    expect(card?.own).toBe(true);
    expect(card?.rule).toBe("kiten card");
  }));

it("policy.tree решает тем же набором правил, что строки", () =>
  withBack(async (back) => {
    deepChain(back.policyFile);
    // Правило, записанное в файл мимо сервера: тот же набор видят и
    // строка, и дерево.
    const db = new DatabaseSync(back.policyFile);
    try {
      db.exec(
        "INSERT OR REPLACE INTO rules (path, verdict) VALUES ('sql-ro', 'allow')",
      );
    } finally {
      db.close();
    }
    const nodes = await tree(back);
    const sql = nodes.find((one) => one.path.join(" ") === "sql-ro");
    expect(sql).toStrictEqual({
      path: ["sql-ro"],
      verdict: "allow",
      rule: "sql-ro",
      own: true,
    });
  }));

it("статика: index.html, assets, маршруты, CSP, без токена", () =>
  withBack(
    async (back) => {
      const get = async (path: string) => {
        const response = await fetch(`${back.url}${path}`);
        return {
          status: response.status,
          body: await response.text(),
          csp: response.headers.get("Content-Security-Policy"),
        };
      };
      const index = await get("/");
      expect(index).toStrictEqual({
        status: 200,
        body: "<html>mpu</html>",
        csp: "default-src 'self'",
      });
      expect((await get("/rules")).body).toBe("<html>mpu</html>");
      const script = await get("/assets/x.js");
      expect([script.status, script.body, script.csp]).toStrictEqual([
        200,
        "console.log(1)",
        "default-src 'self'",
      ]);
      // `..` в пути клиент нормализует сам; закодированный слэш раскодирует
      // уже сервер — выход за каталог отбивается там.
      expect((await get("/assets/..%2f..%2fweb-sessions")).status).toBe(404);
      expect((await get("/assets/nope.js")).status).toBe(404);
    },
    {
      webRoot: (dir) => {
        mkdirSync(`${dir}/web/assets`, { recursive: true });
        writeFileSync(`${dir}/web/index.html`, "<html>mpu</html>");
        writeFileSync(`${dir}/web/assets/x.js`, "console.log(1)");
        return `${dir}/web`;
      },
    },
  ));

it("статики нет — текст «фронт не установлен»", () =>
  withBack(async (back) => {
    const response = await fetch(`${back.url}/`);
    expect([response.status, await response.text()]).toStrictEqual([
      200,
      "mpu-back: фронт не установлен\n",
    ]);
  }));
