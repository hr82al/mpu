import { assertEquals } from "@std/assert";
import { Agent, Human, NOBODY, type Reply } from "./mod.ts";

const REPLY: Reply<string> = {
  yes: () => Promise.resolve("yes"),
  no: () => Promise.resolve("no"),
  absent: () => Promise.resolve("absent"),
};

Deno.test("канал с человеком: да — y/yes в любом регистре", async (t) => {
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
    await t.step(String(answer), async () => {
      const written: string[] = [];
      const human = new Human(
        (text) => void written.push(text),
        () => Promise.resolve(answer),
      );
      assertEquals(await human.ask("вопрос? [y/N] ", REPLY), seen);
      assertEquals(written, ["вопрос? [y/N] "]);
    });
  }
});

Deno.test("канал без человека: спросить некого", async () => {
  assertEquals(await NOBODY.ask("вопрос?", REPLY), "absent");
});

Deno.test("канал человека: вопрос о правиле задаётся так же", async () => {
  const written: string[] = [];
  const human = new Human(
    (text) => void written.push(text),
    () => Promise.resolve("y"),
  );
  assertEquals(await human.amend("правило? [y/N] ", REPLY), "yes");
  assertEquals(written, ["правило? [y/N] "]);
});

Deno.test("канал агента: решение ask — внутреннему, правило — некому", async () => {
  const written: string[] = [];
  const agent = new Agent(
    new Human((text) => void written.push(text), () => Promise.resolve("y")),
  );
  assertEquals(await agent.ask("выполнить? [y/N] ", REPLY), "yes");
  assertEquals(await agent.amend("правило? [y/N] ", REPLY), "absent");
  assertEquals(written, ["выполнить? [y/N] "]);
  assertEquals(await NOBODY.amend("правило?", REPLY), "absent");
});
