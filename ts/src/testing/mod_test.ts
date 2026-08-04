import { assertEquals, assertThrows } from "@std/assert";
import { makeFakeIo } from "./mod.ts";

Deno.test("фейк io: неожидаемое обращение падает с именем операции", () => {
  const io = makeFakeIo();
  assertThrows(
    () => io.launchOpener("xdg-open", "/tmp/x.xlsx"),
    Error,
    "opener must not be touched",
  );
});

Deno.test("фейк io: перечисленное тестом разрешено", async () => {
  const io = makeFakeIo({ readTextFile: () => Promise.resolve("данные") });
  assertEquals(await io.readTextFile("/что угодно"), "данные");
  assertEquals(io.cwd(), "/nowhere");
});
