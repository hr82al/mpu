/**
 * Вопросы владельцу живут весь процесс ядра
 * (`docs/specs/platform/telegram-questions.md`, «Приём апдейтов»,
 * «Перезапуск»): старт сервера их запускает, остановка — останавливает.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { NO_BOT, type OwnerQuestions } from "../botquestions/mod.ts";
import { withBack } from "./testback.ts";

Deno.test("сервер запускает вопросы при старте и останавливает при остановке", async () => {
  const events: string[] = [];
  const questions: OwnerQuestions = {
    ask: NO_BOT.ask,
    start: () => void events.push("start"),
    stop: () => {
      events.push("stop");
      return Promise.resolve();
    },
  };
  await withBack(() => {
    assertEquals(events, ["start"]);
    return Promise.resolve();
  }, { questions });
  assertEquals(events, ["start", "stop"]);
});

Deno.test("порт занят — вопросы не стартуют: опрос и правки ведёт тот, кто слушает", async () => {
  const events: string[] = [];
  const questions: OwnerQuestions = {
    ask: NO_BOT.ask,
    start: () => void events.push("start"),
    stop: () => Promise.resolve(),
  };
  using busy = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  await assertRejects(
    () =>
      withBack(() => Promise.resolve(), {
        port: (busy.addr as Deno.NetAddr).port,
        questions,
      }),
    Deno.errors.AddrInUse,
  );
  assertEquals(events, []);
});
