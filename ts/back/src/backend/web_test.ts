/**
 * Сторона фронта в `mpu-back` (`specs/web.md`, 10a): ключ входа только у
 * двери человека, сессия — cookie с точным `Origin`, в файле — только
 * хэши, `policy.tree` — решения того же набора правил, статика.
 */

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
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
      body: JSON.stringify({ words, cwd: Deno.cwd() }),
    }),
  );
}

/** Ключ из ссылки `web`. */
async function key(back: TestBack): Promise<string> {
  const answer = await lineOf(back, "/line", ["web"]);
  const match = KEY.exec(String(answer.stdout));
  assertEquals(match !== null, true, JSON.stringify(answer));
  assertEquals(match?.[1], new URL(back.url).port);
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
  assertEquals(got.status, 204);
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

Deno.test("web — ссылка с ключом только у двери человека", () =>
  withBack(async (back) => {
    await key(back);
    assertEquals(await lineOf(back, "/agent/line", ["web"]), {
      stdout: "",
      stderr: "mpu: не понимает web\n",
      exit: 2,
    });
    assertEquals((await lineOf(back, "/agent/line", ["web-logout"])).exit, 2);
  }));

Deno.test("ключ: 204 и cookie; второй раз — 404; чужой Origin — 403", () =>
  withBack(async (back) => {
    const value = await key(back);
    assertEquals(
      (await exchange(back, value, "http://evil.localhost")).status,
      403,
    );
    const first = await exchange(back, value);
    assertEquals(first.status, 204);
    assertEquals(
      first.cookie,
      `mpu_session=${first.session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    assertEquals((await exchange(back, value)).status, 404);
  }));

Deno.test("ключ через 61 секунду — 404", async () => {
  using time = new FakeTime();
  await withBack(async (back) => {
    const value = await key(back);
    await time.tickAsync(61_000);
    assertEquals((await exchange(back, value)).status, 404);
  });
});

Deno.test("cookie действует только при Origin страницы фронта", () =>
  withBack(async (back) => {
    const value = await session(back);
    assertEquals(await rpcWithCookie(back, value, origin(back)), 200);
    for (
      const from of [
        undefined,
        "http://localhost:5173",
        "http://mpu.localhost:9999",
      ]
    ) {
      assertEquals(await rpcWithCookie(back, value, from), 401, String(from));
    }
    assertEquals(await rpcWithCookie(back, "0".repeat(32), origin(back)), 401);
    // Сессия есть только в Set-Cookie ответа /web/session.
    assertEquals(back.seen.some((text) => text.includes(value)), false);
    const agent = await fetch(`${back.url}/agent/line`, {
      method: "POST",
      headers: { Cookie: `mpu_session=${value}`, Origin: origin(back) },
      body: JSON.stringify({ words: ["version"], cwd: "/" }),
    });
    await agent.body?.cancel();
    assertEquals(agent.status, 401);
  }));

Deno.test("cookie: сокет /line и изменение правила через номер", () =>
  withBack(async (back) => {
    const value = await session(back);
    const headers = { Cookie: `mpu_session=${value}`, Origin: origin(back) };
    const socket = new Client(back, "/line", { headers, bearer: false });
    await socket.opened();
    socket.start(["version"]);
    assertEquals((await socket.finished()).at(-1), { exit: 0 });
    const allow = await fetch(`${back.url}/line`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        words: ["allow:", "kiten ls"],
        cwd: Deno.cwd(),
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
    assertEquals((await ndjson(back, answered)).at(-1), { exit: 0 });
    assertEquals(
      rulesOf(back.policyFile).find((rule) => rule.path === "kiten ls"),
      { path: "kiten ls", verdict: "allow" },
    );
  }));

Deno.test("файл сессий: 0600, только хэши, переживает перезапуск", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/web-sessions`;
    let value = "";
    await withBack(async (back) => {
      value = await session(back);
      const text = await Deno.readTextFile(back.webSessions);
      assertEquals(text.includes(value), false);
      for (const row of text.split("\n").filter(Boolean)) {
        const stored = row.split(" ")[0];
        assertEquals(await rpcWithCookie(back, stored, origin(back)), 401);
      }
      const mode = (await Deno.stat(back.webSessions)).mode ?? 0;
      assertEquals(mode & 0o777, 0o600);
      await Deno.copyFile(back.webSessions, file);
    });
    const reopened = await WebAccess.open({
      file: secretText(file),
      now: () => Date.now(),
    });
    assertEquals(await reopened.admits(value), true);
    assertEquals(await reopened.admits("f".repeat(32)), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("web-logout — число сессий, после — cookie 401", () =>
  withBack(async (back) => {
    const one = await session(back);
    await session(back);
    const out = await lineOf(back, "/line", ["web-logout"]);
    assertEquals([out.stdout, out.exit], ["2\n", 0]);
    assertEquals(await rpcWithCookie(back, one, origin(back)), 401);
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

Deno.test("policy.tree — голден на «глубокой цепочке»", () =>
  withBack(async (back) => {
    deepChain(back.policyFile);
    const golden = new URL("testdata/web/policy-tree.json", import.meta.url);
    assertEquals(await tree(back), JSON.parse(await Deno.readTextFile(golden)));
  }));

Deno.test("policy.tree после deny: kiten — kiten и потомки без своего правила", () =>
  withBack(async (back) => {
    const [, done] = await httpLine(back, "/line", {
      words: ["deny:", "kiten"],
      cwd: Deno.cwd(),
      human: true,
    }, ["y"]);
    assertEquals(done.at(-1), { exit: 0 });
    const nodes = await tree(back);
    const own = new Set(rulesOf(back.policyFile).map((rule) => rule.path));
    for (const node of nodes.filter((one) => one.path[0] === "kiten")) {
      const path = node.path.join(" ");
      if (own.has(path)) continue;
      assertEquals([node.verdict, node.rule], ["deny", "kiten"], path);
    }
    const kiten = nodes.find((one) => one.path.join(" ") === "kiten");
    assertEquals(kiten, {
      path: ["kiten"],
      verdict: "deny",
      rule: "kiten",
      own: true,
    });
    const card = nodes.find((one) => one.path.join(" ") === "kiten card");
    assertEquals(card?.own, true);
    assertEquals(card?.rule, "kiten card");
  }));

Deno.test("policy.tree решает тем же набором правил, что строки", () =>
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
    assertEquals(sql, {
      path: ["sql-ro"],
      verdict: "allow",
      rule: "sql-ro",
      own: true,
    });
  }));

Deno.test("статика: index.html, assets, маршруты, CSP, без токена", () =>
  withBack(async (back) => {
    const get = async (path: string) => {
      const response = await fetch(`${back.url}${path}`);
      return {
        status: response.status,
        body: await response.text(),
        csp: response.headers.get("Content-Security-Policy"),
      };
    };
    const index = await get("/");
    assertEquals(index, {
      status: 200,
      body: "<html>mpu</html>",
      csp: "default-src 'self'",
    });
    assertEquals((await get("/rules")).body, "<html>mpu</html>");
    const script = await get("/assets/x.js");
    assertEquals([script.status, script.body, script.csp], [
      200,
      "console.log(1)",
      "default-src 'self'",
    ]);
    // `..` в пути клиент нормализует сам; закодированный слэш раскодирует
    // уже сервер — выход за каталог отбивается там.
    assertEquals((await get("/assets/..%2f..%2fweb-sessions")).status, 404);
    assertEquals((await get("/assets/nope.js")).status, 404);
  }, {
    webRoot: (dir) => {
      Deno.mkdirSync(`${dir}/web/assets`, { recursive: true });
      Deno.writeTextFileSync(`${dir}/web/index.html`, "<html>mpu</html>");
      Deno.writeTextFileSync(`${dir}/web/assets/x.js`, "console.log(1)");
      return `${dir}/web`;
    },
  }));

Deno.test("статики нет — текст «фронт не установлен»", () =>
  withBack(async (back) => {
    const response = await fetch(`${back.url}/`);
    assertEquals(
      [response.status, await response.text()],
      [200, "mpu-back: фронт не установлен\n"],
    );
  }));
