/**
 * Сессия и её канал в ядре (`claude-channel.md`, «Регистрация в ядре»):
 * срок доставки, вытеснение, закрытие соединения. Часы ведёт тест.
 */

import { assertEquals } from "@std/assert";
import type { Asked } from "../botquestions/mod.ts";
import { WireLink } from "./channel.ts";
import { NO_CHANNEL } from "./reach.ts";
import { DELIVERY_MS, Session, SESSION_CLOSED } from "./sessions.ts";
import { TestClock } from "./testclock.ts";

/** Провод теста: кадры по порядку; закрыт — не принимает. */
function wire() {
  const frames: string[] = [];
  let open = true;
  return {
    frames,
    shut: () => void (open = false),
    send: (frame: string) => {
      if (!open) return false;
      frames.push(frame);
      return true;
    },
  };
}

/** Вопрос теста: записывает, чем снят. */
function asked(log: string[]): Asked {
  return {
    outcome: new Promise(() => {}),
    placed: Promise.resolve(),
    withdraw: (text) => log.push(`снят: ${text}`),
    withdrawAs: (line) => log.push(`снят строкой: ${line}`),
    expire: () => log.push("истёк"),
  };
}

Deno.test("канал не ответил за срок — отказ доставки; пауза срока погашена", async () => {
  const clock = new TestClock();
  const session = new Session(clock);
  const sent = wire();
  session.attach(new WireLink(sent));
  const delivered = session.deliver("Синий");
  await clock.paused(DELIVERY_MS);
  assertEquals(sent.frames, ['{"deliver":"Синий","id":1}']);
  clock.fire(DELIVERY_MS);
  assertEquals(await delivered, false);
});

Deno.test("ответ канала раньше срока — доставлено", async () => {
  const clock = new TestClock();
  const session = new Session(clock);
  const link = new WireLink(wire());
  session.attach(link);
  const delivered = session.deliver("Синий");
  link.heard('{"delivered":1}');
  assertEquals(await delivered, true);
  // Повтор ответа и чужой номер ничего не решают.
  link.heard('{"delivered":1}');
  link.heard('{"failed":9}');
});

Deno.test("соединение закрылось с доставкой в пути — отказ; новые — отказ сразу", async () => {
  const session = new Session(new TestClock());
  const sent = wire();
  const link = new WireLink(sent);
  session.attach(link);
  const pending = session.deliver("Синий");
  sent.shut();
  link.closed();
  assertEquals(await pending, false);
  assertEquals(await link.deliver("ещё"), false);
});

Deno.test("вытесненный канал закрылся — вопрос не снят; текущий закрылся — «сессия закрыта»", () => {
  const log: string[] = [];
  const session = new Session(new TestClock());
  session.replace(() => asked(log));
  const first = new WireLink(wire());
  const second = new WireLink(wire());
  session.attach(first);
  session.attach(second);
  session.detach(first);
  assertEquals(log, []);
  session.detach(second);
  assertEquals(log, [`снят строкой: ${SESSION_CLOSED}`]);
  assertEquals(session.reach(), NO_CHANNEL);
});

Deno.test("канала нет — доставка отказ сразу, достижимость — без канала", async () => {
  const session = new Session(new TestClock());
  assertEquals(await session.deliver("Синий"), false);
  assertEquals(session.reach(), NO_CHANNEL);
});
