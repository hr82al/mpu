import { describe, expect, it } from "vitest";
import { Agent, Human, NOBODY, type Reply } from "./mod.ts";

const REPLY: Reply<string> = {
  yes: () => Promise.resolve("yes"),
  no: () => Promise.resolve("no"),
  absent: () => Promise.resolve("absent"),
};

describe("канал с человеком: да — y/yes в любом регистре", () => {
  const cases: readonly (readonly [string | undefined, string])[] = [
    ["y", "yes"],
    ["YES", "yes"],
    ["Yes ", "yes"],
    ["n", "no"],
    ["", "no"],
    ["yess", "no"],
    [undefined, "no"],
  ];
  for (const [answer, seen] of cases) {
    it(String(answer), async () => {
      const written: string[] = [];
      const human = new Human(
        (text) => void written.push(text),
        () => Promise.resolve(answer),
      );
      expect(await human.ask("вопрос? [y/N] ", REPLY)).toStrictEqual(seen);
      expect(written).toStrictEqual(["вопрос? [y/N] "]);
    });
  }
});

it("канал без человека: спросить некого", async () => {
  expect(await NOBODY.ask("вопрос?", REPLY)).toBe("absent");
});

it("канал человека: вопрос о правиле задаётся так же", async () => {
  const written: string[] = [];
  const human = new Human(
    (text) => void written.push(text),
    () => Promise.resolve("y"),
  );
  expect(await human.amend("правило? [y/N] ", REPLY)).toBe("yes");
  expect(written).toStrictEqual(["правило? [y/N] "]);
});

it("канал агента: решение ask — внутреннему, правило — некому", async () => {
  const written: string[] = [];
  const agent = new Agent(
    new Human(
      (text) => void written.push(text),
      () => Promise.resolve("y"),
    ),
  );
  expect(await agent.ask("выполнить? [y/N] ", REPLY)).toBe("yes");
  expect(await agent.amend("правило? [y/N] ", REPLY)).toBe("absent");
  expect(written).toStrictEqual(["выполнить? [y/N] "]);
  expect(await NOBODY.amend("правило?", REPLY)).toBe("absent");
});
