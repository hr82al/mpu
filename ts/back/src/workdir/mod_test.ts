import { assertEquals } from "@std/assert";
import { Workdir } from "./mod.ts";

Deno.test("каталог вызова: абсолютный путь как есть, относительный — от него", async (t) => {
  const dir = new Workdir("/дом/строки");
  assertEquals(dir.path(), "/дом/строки");
  const cases: readonly (readonly [string, string])[] = [
    ["note.txt", "/дом/строки/note.txt"],
    ["вложенный/note.txt", "/дом/строки/вложенный/note.txt"],
    ["./note.txt", "/дом/строки/./note.txt"],
    ["../сосед/note.txt", "/дом/строки/../сосед/note.txt"],
    ["/абсолютный/note.txt", "/абсолютный/note.txt"],
    ["", "/дом/строки"],
  ];
  for (const [given, expected] of cases) {
    await t.step(given === "" ? "пустой путь" : given, () => {
      assertEquals(dir.resolve(given), expected);
    });
  }
});
