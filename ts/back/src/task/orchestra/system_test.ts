/**
 * Настоящие порты поверх поддельного запуска программ: какие строки
 * `tmux` и `notify-send` уходят наружу (настоящий tmux в тестах не
 * запускается — постановка T3), и цикл шагов на поддельных часах.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { pause, runSteps, STEP_MS } from "./run.ts";
import {
  NOTIFY_SEND,
  type Ran,
  type Run,
  SYSTEM_LETTERS,
  SystemNotices,
  TMUX,
  TmuxError,
  TmuxWindows,
} from "./system.ts";

const PLACE = { session: "w", window: "demo-exec" };

/** Запуск, отвечающий `answer` и записывающий вызовы. */
function recording(answer: Partial<Ran> = {}) {
  const calls: string[][] = [];
  const run: Run = (program, args) => {
    calls.push([program, ...args]);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...answer });
  };
  return { calls, run };
}

Deno.test("tmux: строки команд — точные цели, набор буквально, Enter отдельно", async () => {
  const { calls, run } = recording({ stdout: "claude\n" });
  const windows = new TmuxWindows(run);
  await windows.newSession(PLACE, "/d");
  await windows.newWindow(PLACE, "/d");
  assertEquals(await windows.command(PLACE), "claude");
  await windows.type(PLACE, "-a /clear");
  await windows.enter(PLACE);
  await windows.close(PLACE);
  assertEquals(calls, [
    [TMUX, "new-session", "-d", "-s", "w", "-n", "demo-exec", "-c", "/d"],
    [TMUX, "new-window", "-d", "-t", "=w:", "-n", "demo-exec", "-c", "/d"],
    [
      TMUX,
      "display-message",
      "-p",
      "-t",
      "=w:=demo-exec",
      "#{pane_current_command}",
    ],
    [TMUX, "send-keys", "-t", "=w:=demo-exec", "-l", "--", "-a /clear"],
    [TMUX, "send-keys", "-t", "=w:=demo-exec", "Enter"],
    [TMUX, "kill-window", "-t", "=w:=demo-exec"],
  ]);
});

Deno.test("tmux: окна нет — command undefined, has-session — по коду", async () => {
  const { run } = recording({ code: 1, stderr: "can't find window" });
  const windows = new TmuxWindows(run);
  assertEquals(await windows.command(PLACE), undefined);
  assertEquals(await windows.hasSession("w"), false);
  assertEquals(await new TmuxWindows(recording().run).hasSession("w"), true);
});

Deno.test("tmux: сбой команды — TmuxError с её stderr", async () => {
  const windows = new TmuxWindows(
    recording({ code: 1, stderr: "no server running\n" }).run,
  );
  await assertRejects(
    () => windows.screen(PLACE),
    TmuxError,
    "tmux capture-pane: no server running",
  );
});

Deno.test("уведомление: строка лога и notify-send; программы нет — только строка", async () => {
  const lines: string[] = [];
  const { calls, run } = recording();
  await new SystemNotices((text) => lines.push(text), run).notify("demo: x");
  assertEquals(calls, [[NOTIFY_SEND, "mpu task", "demo: x"]]);
  const missing: Run = () => Promise.reject(new Deno.errors.NotFound("нет"));
  await new SystemNotices((text) => lines.push(text), missing).notify("y");
  const broken: Run = () => Promise.reject(new Error("отказано"));
  await new SystemNotices((text) => lines.push(text), broken).notify("z");
  await new SystemNotices((text) => lines.push(text), run).log("w");
  assertEquals(lines, ["demo: x", "y", "z", "notify-send: отказано", "w"]);
  assertEquals(calls.length, 1);
});

Deno.test("файл первого сообщения: каталог создан, повтор перезаписывает", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/mpu-task/demo/exec.md`;
    await SYSTEM_LETTERS.write(path, "a");
    await SYSTEM_LETTERS.write(path, "b");
    assertEquals(await Deno.readTextFile(path), "b");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("цикл: шаг каждые 5 с, сбой шага — строка лога, сигнал кончает", async () => {
  using time = new FakeTime();
  const stopping = new AbortController();
  const lines: string[] = [];
  let steps = 0;
  const done = runSteps(
    {
      step: () => {
        steps += 1;
        return steps === 2
          ? Promise.reject(new Error("база занята"))
          : Promise.resolve();
      },
    },
    stopping.signal,
    (text) => lines.push(text),
  );
  await time.tickAsync(STEP_MS - 1);
  assertEquals(steps, 1);
  await time.tickAsync(1);
  await time.runMicrotasks();
  await time.tickAsync(STEP_MS);
  stopping.abort();
  await done;
  assertEquals(steps, 3);
  assertEquals(lines, ["шаг: база занята"]);
});

Deno.test("сигнал во время шага — цикл кончается без паузы", async () => {
  using _time = new FakeTime();
  const stopping = new AbortController();
  let steps = 0;
  await runSteps(
    {
      step: () => {
        steps += 1;
        stopping.abort();
        return Promise.resolve();
      },
    },
    stopping.signal,
    () => {},
  );
  assertEquals(steps, 1);
});

Deno.test("пауза без сигнала — по сроку", async () => {
  using time = new FakeTime();
  let over = false;
  const waiting = pause(1000).then(() => over = true);
  await time.tickAsync(999);
  assertEquals(over, false);
  await time.tickAsync(1);
  await waiting;
  assertEquals(over, true);
});
