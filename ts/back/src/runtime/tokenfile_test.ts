import { assertEquals } from "@std/assert";
import { tokenFile } from "./mod.ts";

Deno.test("файл токена: нет — undefined, запись — 0600 и каталог", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = tokenFile(`${dir}/state/agent-token`);
    assertEquals(await file.readAccessToken(), undefined);
    await file.writeAccessToken("abc");
    assertEquals(await file.readAccessToken(), "abc");
    const mode = (await Deno.stat(`${dir}/state/agent-token`)).mode ?? 0;
    assertEquals(mode & 0o777, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
