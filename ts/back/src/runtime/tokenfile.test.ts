import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tokenFile } from "./mod.ts";

it("файл токена: нет — undefined, запись — 0600 и каталог", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const file = tokenFile(`${dir}/state/agent-token`);
    expect(await file.readAccessToken()).toStrictEqual(undefined);
    await file.writeAccessToken("abc");
    expect(await file.readAccessToken()).toBe("abc");
    const mode = (await stat(`${dir}/state/agent-token`)).mode;
    expect(mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true });
  }
});
