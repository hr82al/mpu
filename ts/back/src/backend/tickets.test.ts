/**
 * Хранилище номеров (`platform/back-http-line.md`): номер одноразовый,
 * своей двери и своего вызывающего; строка, ждущая по номеру, при
 * остановке сервера не исполняется, и номер не остаётся висеть.
 */

import { expect, it } from "vitest";
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

it("номер: случайный, 32 шестнадцатеричных знака", () => {
  expect(/^[0-9a-f]{32}$/.test(randomTicket())).toBe(true);
  expect(randomTicket() === randomTicket()).toBe(false);
});

it("номер: один раз, только своя дверь и свой вызывающий", async () => {
  const tickets = new Tickets(() => "n1");
  const { line, frames, answer } = waitingLine(tickets);
  expect(frames).toStrictEqual([{ ask: "выполнить? [y/N] ", ticket: "n1" }]);
  expect(tickets.take("n1", AGENT_DOOR, OWNER)).toStrictEqual(undefined);
  expect(tickets.take("n1", HUMAN_DOOR, AGENT)).toStrictEqual(undefined);
  expect(tickets.take("n1", HUMAN_DOOR, OWNER)?.line).toStrictEqual(line);
  line.resume(DETACHED, "y");
  expect(await answer).toBe("y");
  expect(tickets.take("n1", HUMAN_DOOR, OWNER)).toStrictEqual(undefined);
});

it("остановка: ждущая номера строка не исполняется, номер отозван", async () => {
  const tickets = new Tickets(() => "n2");
  const { line, answer } = waitingLine(tickets);
  line.stop();
  expect(await answer).toStrictEqual(undefined);
  expect(tickets.take("n2", HUMAN_DOOR, OWNER)).toStrictEqual(undefined);
  let ran = false;
  const code = await line.execute(() => {
    ran = true;
    return Promise.resolve(0);
  }, new Lines(1));
  expect([code, ran]).toStrictEqual([1, false]);
});
