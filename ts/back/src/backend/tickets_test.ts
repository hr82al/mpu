/**
 * Хранилище номеров (`platform/back-http-line.md`): номер одноразовый,
 * своей двери и своего вызывающего; строка, ждущая по номеру, при
 * остановке сервера не исполняется, и номер не остаётся висеть.
 */

import { assertEquals } from "@std/assert";
import { AGENT, OWNER } from "./caller.ts";
import { AGENT_DOOR, HUMAN_DOOR } from "./door.ts";
import { ticketAsking } from "./http.ts";
import { DETACHED, Line } from "./line.ts";
import { Lines } from "./limit.ts";
import { randomTicket, Tickets } from "./tickets.ts";

function waitingLine(tickets: Tickets) {
  const frames: unknown[] = [];
  const line = new Line(
    {
      frame: (frame) => void frames.push(frame),
      ready: () => Promise.resolve(),
      end() {},
    },
    ticketAsking(tickets, HUMAN_DOOR, OWNER),
    Promise.resolve(),
  );
  line.question("выполнить? [y/N] ");
  return { line, frames, answer: line.answer() };
}

Deno.test("номер: случайный, 32 шестнадцатеричных знака", () => {
  assertEquals(/^[0-9a-f]{32}$/.test(randomTicket()), true);
  assertEquals(randomTicket() === randomTicket(), false);
});

Deno.test("номер: один раз, только своя дверь и свой вызывающий", async () => {
  const tickets = new Tickets(() => "n1");
  const { line, frames, answer } = waitingLine(tickets);
  assertEquals(frames, [{ ask: "выполнить? [y/N] ", ticket: "n1" }]);
  assertEquals(tickets.take("n1", AGENT_DOOR, OWNER), undefined);
  assertEquals(tickets.take("n1", HUMAN_DOOR, AGENT), undefined);
  assertEquals(tickets.take("n1", HUMAN_DOOR, OWNER), line);
  line.resume(DETACHED, "y");
  assertEquals(await answer, "y");
  assertEquals(tickets.take("n1", HUMAN_DOOR, OWNER), undefined);
});

Deno.test("остановка: ждущая номера строка не исполняется, номер отозван", async () => {
  const tickets = new Tickets(() => "n2");
  const { line, answer } = waitingLine(tickets);
  line.stop();
  assertEquals(await answer, undefined);
  assertEquals(tickets.take("n2", HUMAN_DOOR, OWNER), undefined);
  let ran = false;
  const code = await line.execute(() => {
    ran = true;
    return Promise.resolve(0);
  }, new Lines(1));
  assertEquals([code, ran], [1, false]);
});
