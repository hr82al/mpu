/**
 * Гонка ответа на вопрос строки (`platform/ask-telegram.md` [D.1]):
 * канал строки и второй адресат — владелец в чате; решает первый ответ,
 * проигравший снимается своим способом.
 */

import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import type { ServerFrame } from "../frames/mod.ts";
import { OWNER } from "./caller.ts";
import { AGENT_DOOR, HUMAN_DOOR } from "./door.ts";
import { ticketAsking } from "./http.ts";
import {
  ANSWER_TIMEOUT_MS,
  type Asking,
  type Delivery,
  DETACHED,
  Line,
  type Rival,
} from "./line.ts";
import { Tickets } from "./tickets.ts";

/** Второй адресат, которым правит тест: что ему сказали и чем ответить. */
function chat() {
  const told: string[] = [];
  let decide: (answer: string, said: string) => void = () => {
    throw new Error("второй адресат не спрошен");
  };
  const closed = Promise.withResolvers<void>();
  const rival: Rival = {
    start(given) {
      told.push("спрошен");
      decide = given;
      return {
        answered: () => {
          told.push("ответ канала");
          closed.resolve();
        },
        lapsed: () => {
          told.push("истёк");
          closed.resolve();
        },
        closed: () => closed.promise,
      };
    },
  };
  return {
    rival,
    told,
    decide: (answer: string) => decide(answer, said(answer)),
  };
}

function said(answer: string): string {
  return `решено в Telegram — ${answer === "y" ? "да" : "нет"}`;
}

function recording(frames: ServerFrame[]): Delivery {
  return {
    frame: (frame) => void frames.push(frame),
    ready: () => Promise.resolve(),
    end() {},
  };
}

/**
 * Канал строки в тесте — как у сокета: кадр вопроса, решение в другом
 * месте — кадром `settled` и ответом строке. Настоящий сокет проверяет
 * `ask_chat_test.ts` по проводу.
 */
const FRAMES: Asking = {
  pose(line, question) {
    line.deliver({ ask: question });
    return {
      revoke() {},
      settle(line, answer, said) {
        line.deliver({ settled: said });
        line.answered(answer);
      },
      admits: (rival) => rival,
    };
  },
};

function asked(asking: Asking) {
  const frames: ServerFrame[] = [];
  const line = new Line(recording(frames), asking, Promise.resolve());
  return { line, frames };
}

Deno.test("кадром: ответ из чата — кадр settled, строке его ответ", async () => {
  const { line, frames } = asked(FRAMES);
  const { rival, told, decide } = chat();
  line.question("выполнить mpu x? [y/N] ", "line", rival);
  const answer = line.answer();
  decide("y");
  assertEquals(await answer, "y");
  assertEquals(frames, [
    { ask: "выполнить mpu x? [y/N] " },
    { settled: "решено в Telegram — да" },
  ]);
  // Ответ канала после решения — второй: его не ждёт никто.
  line.answered("n");
  assertEquals(told, ["спрошен", "ответ канала"]);
});

Deno.test("кадром: ответ канала первым — чат снят, его ответ не принят", async () => {
  const { line, frames } = asked(FRAMES);
  const { rival, told, decide } = chat();
  line.question("выполнить mpu x? [y/N] ", "line", rival);
  const answer = line.answer();
  line.answered("y");
  assertEquals(await answer, "y");
  decide("n");
  assertEquals(told, ["спрошен", "ответ канала"]);
  assertEquals(frames, [{ ask: "выполнить mpu x? [y/N] " }]);
});

Deno.test("срок и закрытие строки — чат истёк", async (t) => {
  await t.step("срок ответа", async () => {
    using time = new FakeTime();
    const { line } = asked(FRAMES);
    const { rival, told } = chat();
    line.question("выполнить mpu x? [y/N] ", "line", rival);
    const answer = line.answer();
    await time.tickAsync(ANSWER_TIMEOUT_MS);
    assertEquals(await answer, undefined);
    assertEquals(told, ["спрошен", "истёк"]);
  });
  await t.step("строка закрыта, пока ждёт", async () => {
    const { line } = asked(FRAMES);
    const { rival, told } = chat();
    line.question("выполнить mpu x? [y/N] ", "line", rival);
    const answer = line.answer();
    line.shut();
    assertEquals(await answer, undefined);
    assertEquals(told, ["спрошен", "истёк"]);
  });
});

Deno.test("закрытая строка второго адресата не спрашивает", async () => {
  const { line } = asked(FRAMES);
  const { rival, told } = chat();
  line.shut();
  line.question("выполнить mpu x? [y/N] ", "line", rival);
  assertEquals(await line.answer(), undefined);
  assertEquals(told, []);
});

Deno.test("номер: решено в чате — строка ждёт, пока решение не заберут", async (t) => {
  for (
    const [name, given] of [
      ["запрос решения", ""],
      ["ответ по номеру, присланный позже", "n"],
    ] as const
  ) {
    await t.step(name, async () => {
      const tickets = new Tickets(() => "n1");
      const { line, frames } = asked(
        ticketAsking(tickets, AGENT_DOOR, OWNER),
      );
      const { rival, told, decide } = chat();
      line.question("выполнить mpu x? [y/N] ", "line", rival);
      const answer = line.answer();
      const claim = tickets.take("n1", AGENT_DOOR, OWNER);
      if (claim === undefined) throw new Error("номер не выдан");
      const settled = claim.settled(new AbortController().signal);
      decide("y");
      assertEquals(
        (await settled).read({ decided: (said) => said, gone: () => "нет" }),
        "решено в Telegram — да",
      );
      // Решение не уходит кадром: у строки с номером доставки нет.
      assertEquals(frames, [{ ask: "выполнить mpu x? [y/N] ", ticket: "n1" }]);
      assertEquals(told, ["спрошен"]);
      line.resume(DETACHED, claim.answer(given));
      assertEquals(await answer, "y");
      assertEquals(tickets.take("n1", AGENT_DOOR, OWNER), undefined);
    });
  }
});

Deno.test("номер: ответ канала первым — ожидание решения снаружи кончается", async () => {
  const tickets = new Tickets(() => "n2");
  const { line } = asked(ticketAsking(tickets, AGENT_DOOR, OWNER));
  const { rival, told } = chat();
  line.question("выполнить mpu x? [y/N] ", "line", rival);
  const answer = line.answer();
  const claim = tickets.take("n2", AGENT_DOOR, OWNER);
  if (claim === undefined) throw new Error("номер не выдан");
  const settled = claim.settled(new AbortController().signal);
  line.resume(DETACHED, claim.answer("y"));
  assertEquals(await answer, "y");
  assertEquals(
    (await settled).read({ decided: () => "решено", gone: () => "нет" }),
    "нет",
  );
  assertEquals(told, ["спрошен", "ответ канала"]);
});

Deno.test("номер: запрос ушёл, не дождавшись, — строка ждёт дальше", async () => {
  const tickets = new Tickets(() => "n3");
  const { line } = asked(ticketAsking(tickets, HUMAN_DOOR, OWNER));
  line.question("выполнить mpu x? [y/N] ");
  const answer = line.answer();
  const claim = tickets.take("n3", HUMAN_DOOR, OWNER);
  if (claim === undefined) throw new Error("номер не выдан");
  const left = new AbortController();
  const settled = claim.settled(left.signal);
  left.abort();
  assertEquals(
    (await settled).read({ decided: () => "решено", gone: () => "нет" }),
    "нет",
  );
  assertEquals(tickets.take("n3", HUMAN_DOOR, OWNER), claim);
  line.resume(DETACHED, claim.answer("y"));
  assertEquals(await answer, "y");
});

Deno.test("номер двери человека: второго адресата нет — снять вопрос страницы нечем", async () => {
  const tickets = new Tickets(() => "n4");
  const { line } = asked(ticketAsking(tickets, HUMAN_DOOR, OWNER));
  const { rival, told } = chat();
  line.question("выполнить mpu x? [y/N] ", "line", rival);
  const answer = line.answer();
  tickets.take("n4", HUMAN_DOOR, OWNER)?.line.resume(DETACHED, "y");
  assertEquals(await answer, "y");
  assertEquals(told, []);
});

Deno.test("номер: сигнал прерван до ожидания — ждать нечего, номер цел", async () => {
  const tickets = new Tickets(() => "n5");
  const { line } = asked(ticketAsking(tickets, AGENT_DOOR, OWNER));
  line.question("выполнить mpu x? [y/N] ");
  const answer = line.answer();
  const claim = tickets.take("n5", AGENT_DOOR, OWNER);
  if (claim === undefined) throw new Error("номер не выдан");
  const settled = await claim.settled(AbortSignal.abort());
  assertEquals(
    settled.read({ decided: () => "решено", gone: () => "нет" }),
    "нет",
  );
  claim.line.resume(DETACHED, claim.answer("n"));
  assertEquals(await answer, "n");
});
