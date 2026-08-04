import { assertEquals, assertRejects } from "@std/assert";
import { DomainError } from "../command/mod.ts";
import { accessTokenPath, makeDenoIo } from "./mod.ts";

Deno.test("файл токена — сосед хранилища конфига", () => {
  assertEquals(
    accessTokenPath("/home/u/.config/mpu/config.json"),
    "/home/u/.config/mpu/token",
  );
  // Без HOME хранилища нет, а значит негде держать и токен.
  assertEquals(accessTokenPath(undefined), undefined);
});

Deno.test("без конфиг-каталога токен не читается и не пишется", async () => {
  const io = makeDenoIo(undefined);
  assertEquals(await io.readAccessToken(), undefined);
  // Отказ штатный (exit 1), а не «unexpected»: пользователю сообщают
  // причину, а не трейс.
  await assertRejects(
    () => io.writeAccessToken("любой"),
    DomainError,
    "config store is unavailable",
  );
});

Deno.test("токен читается без хвостового перевода строки", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const io = makeDenoIo(`${dir}/config.json`);
    await io.writeAccessToken("token-value");
    assertEquals(await io.readAccessToken(), "token-value");
    assertEquals(await Deno.readTextFile(`${dir}/token`), "token-value\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
