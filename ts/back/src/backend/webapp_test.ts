/**
 * Сквозной путь фронта (`specs/web.md`): собранная статика отдаётся
 * `mpu-back`, вход по ключу даёт cookie, `policy.tree` с ней и точным
 * `Origin` читается. Фронт здесь не импортируется — только собирается задачей `compile:web`.
 */

import { assertEquals } from "@std/assert";
import { collected, withBack } from "./testback.ts";

async function build(out: string) {
  const output = await new Deno.Command("deno", {
    args: ["task", "compile:web"],
    env: { MPU_OUT: out },
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
}

Deno.test("статика приложения и policy.tree по cookie", async () => {
  const dist = await Deno.makeTempDir();
  try {
    await build(dist);
    await withBack(async (back) => {
      const page = await fetch(`${back.url}/`);
      const html = await page.text();
      assertEquals(page.status, 200);
      assertEquals(html.includes('<div id="root"></div>'), true);
      assertEquals(
        page.headers.get("Content-Security-Policy"),
        "default-src 'self'",
      );
      const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? "";
      assertEquals(
        (await (await fetch(`${back.url}${script}`)).text()).length > 0,
        true,
      );

      const web = await collected(
        back,
        await fetch(`${back.url}/line`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${back.token}`,
            Accept: "application/json",
          },
          body: JSON.stringify({ words: ["web"], cwd: Deno.cwd() }),
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
      assertEquals(session.status, 204);
      const cookie = (session.headers.get("Set-Cookie") ?? "").split(";")[0];
      const tree = await fetch(`${back.url}/rpc`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "policy.tree" }),
      });
      const body = await tree.json();
      assertEquals(tree.status, 200);
      assertEquals(body.result[0].path, []);
    }, { webRoot: () => dist });
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});
