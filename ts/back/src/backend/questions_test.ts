/**
 * Вопросы владельцу живут весь процесс ядра
 * (`docs/specs/platform/telegram-questions.md`, «Приём апдейтов»,
 * «Перезапуск»): старт сервера их запускает, остановка — останавливает.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { NO_BOT, type OwnerQuestions } from "../botquestions/mod.ts";
import type { CommandIo } from "../command/mod.ts";
import { type Launcher, MemoryLauncher } from "../worker/mod.ts";
import { FIRST_WORKER_PID, withBack } from "./testback.ts";

Deno.test("сервер запускает вопросы при старте и останавливает при остановке", async () => {
  const events: string[] = [];
  const questions: OwnerQuestions = {
    ask: NO_BOT.ask,
    post: NO_BOT.post,
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

/** Имена во временном каталоге процесса: там `withBack` заводит свой. */
async function tempEntries(): Promise<readonly string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(Deno.env.get("TMPDIR") ?? "/tmp")) {
    names.push(entry.name);
  }
  return names;
}

Deno.test("порт занят — ни вопросов, ни исполнителей, ни каталога", async () => {
  const events: string[] = [];
  const questions: OwnerQuestions = {
    ask: NO_BOT.ask,
    post: NO_BOT.post,
    start: () => void events.push("start"),
    stop: () => Promise.resolve(),
  };
  let launched = 0;
  const launcher = (io: CommandIo): Launcher => {
    const memory = new MemoryLauncher(io, FIRST_WORKER_PID, () => Date.now());
    return {
      launch: () => {
        launched++;
        return memory.launch();
      },
    };
  };
  const before = new Set(await tempEntries());
  using busy = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  await assertRejects(
    () =>
      withBack(() => Promise.resolve(), {
        port: (busy.addr as Deno.NetAddr).port,
        questions,
        launcher,
      }),
    Deno.errors.AddrInUse,
  );
  assertEquals(events, []);
  assertEquals(launched, 0, "исполнители запущены процессом без порта");
  const left = (await tempEntries()).filter((name) => !before.has(name));
  assertEquals(left, [], "каталог стенда остался");
});
