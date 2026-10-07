/**
 * Сквозной путь фронта (`specs/web.md`): собранная статика отдаётся
 * `mpu-back`, вход по ключу даёт cookie, `policy.tree` с ней и точным
 * `Origin` читается. Фронт здесь не импортируется — только собирается задачей `compile:web`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { collected, withBack } from "./testback.ts";

async function build(out: string) {
  // Окружение — родителя плюс своё: `env` у `spawn` заменяет его целиком.
  // Сборка — скриптом `package.json` через `bun`: он и есть инструмент
  // сборки дерева при любом рантайме тестов.
  const child = spawn("bun", ["run", "compile:web"], {
    env: { ...process.env, MPU_OUT: out },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr += chunk);
  const [code] = await once(child, "close");
  expect(code, stderr).toBe(0);
}

it("статика приложения и policy.tree по cookie", async () => {
  const dist = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    await build(dist);
    await withBack(async (back) => {
      const page = await fetch(`${back.url}/`);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html.includes('<div id="root"></div>')).toBe(true);
      expect(page.headers.get("Content-Security-Policy")).toBe(
        "default-src 'self'",
      );
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? "";
      expect((await (await fetch(`${back.url}${script}`)).text()).length > 0)
        .toBe(true);

      const web = await collected(
        back,
        await fetch(`${back.url}/line`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${back.token}`,
            Accept: "application/json",
          },
          body: JSON.stringify({ words: ["web"], cwd: process.cwd() }),
        }),
      );
      const link = new URL(String(web.stdout).trim());
      const origin = `http://mpu.localhost:${new URL(back.url).port}`;
      const session = await fetch(`${back.url}/web/session`, {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({ key: link.searchParams.get("key") }),
      });
      await session.body?.cancel();
      expect(session.status).toBe(204);
      const cookie = (session.headers.get("Set-Cookie") ?? "").split(";")[0];
      const tree = await fetch(`${back.url}/rpc`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "policy.tree" }),
      });
      const body = await tree.json();
      expect(tree.status).toBe(200);
      expect(body.result[0].path).toStrictEqual([]);
    }, { webRoot: () => dist });
  } finally {
    await rm(dist, { recursive: true });
  }
});
