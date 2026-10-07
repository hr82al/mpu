import { beforeAll, describe, expect, it } from "vitest";
import { Workdir } from "./mod.ts";

describe("каталог вызова: абсолютный путь как есть, относительный — от него", () => {
  const dir = new Workdir("/дом/строки");
  const cases: readonly (readonly [string, string])[] = [
    ["note.txt", "/дом/строки/note.txt"],
    ["вложенный/note.txt", "/дом/строки/вложенный/note.txt"],
    ["./note.txt", "/дом/строки/./note.txt"],
    ["../сосед/note.txt", "/дом/строки/../сосед/note.txt"],
    ["/абсолютный/note.txt", "/абсолютный/note.txt"],
    ["", "/дом/строки"],
  ];
  beforeAll(() => {
    expect(dir.path()).toBe("/дом/строки");
  });
  for (const [given, expected] of cases) {
    it(given === "" ? "пустой путь" : given, () => {
      expect(dir.resolve(given)).toStrictEqual(expected);
    });
  }
});
