/**
 * Настоящие порты поверх поддельного запуска программ: какие строки
 * `tmux` и `notify-send` уходят наружу (настоящий tmux в тестах не
 * запускается — постановка T3), и цикл шагов на поддельных часах.
 */

import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { osError } from "../../oserror/mod.ts";
import { fakeTimers } from "../../testing/scope.ts";
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

it("tmux: строки команд — точные цели, набор буквально, Enter отдельно", async () => {
  const { calls, run } = recording({ stdout: "claude\n" });
  const windows = new TmuxWindows(run);
  await windows.newSession(PLACE, "/d");
  await windows.newWindow(PLACE, "/d");
  expect(await windows.command(PLACE)).toBe("claude");
  await windows.type(PLACE, "-a /clear");
  await windows.enter(PLACE);
  await windows.close(PLACE);
  expect(calls).toStrictEqual([
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

it("tmux: окна нет — command undefined, has-session — по коду", async () => {
  const { run } = recording({ code: 1, stderr: "can't find window" });
  const windows = new TmuxWindows(run);
  expect(await windows.command(PLACE)).toStrictEqual(undefined);
  expect(await windows.hasSession("w")).toBe(false);
  expect(await new TmuxWindows(recording().run).hasSession("w")).toBe(true);
});

it("tmux: сбой команды — TmuxError с её stderr", async () => {
  const windows = new TmuxWindows(
    recording({ code: 1, stderr: "no server running\n" }).run,
  );
  const failure = windows.screen(PLACE);
  await expect(failure).rejects.toThrow(TmuxError);
  await expect(failure).rejects.toThrow("tmux capture-pane: no server running");
});

it("уведомление: строка лога и notify-send; программы нет — только строка", async () => {
  const lines: string[] = [];
  const { calls, run } = recording();
  await new SystemNotices((text) => lines.push(text), run).notify("demo: x");
  expect(calls).toStrictEqual([[NOTIFY_SEND, "mpu task", "demo: x"]]);
  const missing: Run = () => Promise.reject(osError("ENOENT", "нет"));
  await new SystemNotices((text) => lines.push(text), missing).notify("y");
  const broken: Run = () => Promise.reject(new Error("отказано"));
  await new SystemNotices((text) => lines.push(text), broken).notify("z");
  await new SystemNotices((text) => lines.push(text), run).log("w");
  expect(lines).toStrictEqual([
    "demo: x",
    "y",
    "z",
    "notify-send: отказано",
    "w",
  ]);
  expect(calls.length).toBe(1);
});

it("файл первого сообщения: каталог создан, повтор перезаписывает", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mpu-"));
  try {
    const path = `${dir}/mpu-task/demo/exec.md`;
    await SYSTEM_LETTERS.write(path, "a");
    await SYSTEM_LETTERS.write(path, "b");
    expect(await readFile(path, "utf8")).toBe("b");
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("цикл: шаг каждые 5 с, сбой шага — строка лога, сигнал кончает", async () => {
  fakeTimers();
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
  await vi.advanceTimersByTimeAsync(STEP_MS - 1);
  expect(steps).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(STEP_MS);
  stopping.abort();
  await done;
  expect(steps).toBe(3);
  expect(lines).toStrictEqual(["шаг: база занята"]);
});

it("сигнал во время шага — цикл кончается без паузы", async () => {
  fakeTimers();
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
  expect(steps).toBe(1);
});

it("пауза без сигнала — по сроку", async () => {
  fakeTimers();
  let over = false;
  const waiting = pause(1000).then(() => (over = true));
  await vi.advanceTimersByTimeAsync(999);
  expect(over).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  expect(over).toBe(true);
});
