/**
 * Супервизор с настоящими процессами (`platform/supervisor-install.md`):
 * перезапуск одного не трогает другого, сигналы адресуются дочернему,
 * остановка гасит обоих (упрямого — `SIGKILL`), вывод — с префиксами.
 * Дочерние — поддельные (`testdata/fake_child.ts` через `deno`), часы —
 * поддельные: паузы и ожидание `SIGKILL` отпускает тест.
 */

import { assertEquals } from "@std/assert";
import {
  type Clock,
  KILL_AFTER_MS,
  type Launcher,
  runSupervisor,
  Supervisor,
  type SupervisorSignal,
  SYSTEM_LAUNCHER,
} from "./mod.ts";

const FAKE = new URL("testdata/fake_child.ts", import.meta.url).pathname;

/** Путь программы — поведение поддельного дочернего. */
const LAUNCHER: Launcher = {
  spawn: (mode, args, line) =>
    SYSTEM_LAUNCHER.spawn(
      "deno",
      ["run", "--no-lock", FAKE, mode, ...args],
      line,
    ),
};

/** Часы: первые `free` пауз отпускаются сразу, дальше — ждут остановки. */
function clock(free: number) {
  const pauses: number[] = [];
  const kills: (() => void)[] = [];
  const asked: (() => void)[] = [];
  const fake: Clock = {
    now: () => 0,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        if (ms === KILL_AFTER_MS) {
          kills.push(resolve);
          for (const wake of asked.splice(0)) wake();
          return;
        }
        pauses.push(ms);
        if (pauses.length <= free) resolve();
      });
    },
  };
  /** Кто-то ждёт `SIGKILL`: «прошло 10 с» — всем ждущим. */
  const expire = async () => {
    while (kills.length === 0) {
      const next = Promise.withResolvers<void>();
      asked.push(next.resolve);
      await next.promise;
    }
    for (const kill of kills.splice(0)) kill();
  };
  return { fake, pauses, expire };
}

/** Строки супервизора и ожидание строки по условию. */
function log() {
  const lines: string[] = [];
  const asked: (() => void)[] = [];
  const push = (text: string) => {
    lines.push(text);
    for (const wake of asked.splice(0)) wake();
  };
  const until = async (match: (lines: string[]) => boolean) => {
    while (!match(lines)) {
      const next = Promise.withResolvers<void>();
      asked.push(next.resolve);
      await next.promise;
    }
  };
  return { lines, until, sink: { out: push, err: push } };
}

/** PID-ы запусков дочернего `name` по строкам супервизора. */
function pids(lines: readonly string[], name: string): number[] {
  const prefix = `[supervisor] ${name}: запущен, pid `;
  return lines.filter((line) => line.startsWith(prefix)).map((line) =>
    Number(line.slice(prefix.length))
  );
}

/** Сторож: ожидание, которое не наступит, — отказ теста, а не зависание. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  const watchdog = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => watchdog.reject(new Error(`не дождались: ${what}`)),
    10_000,
  );
  try {
    return await Promise.race([promise, watchdog.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function alive(pid: number): boolean {
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

Deno.test("back падает трижды: паузы 1, 2, 4 с, mcp жив с прежним PID", async () => {
  const time = clock(3);
  const out = log();
  const supervisor = new Supervisor({
    back: "crash",
    mcp: "live",
    launcher: LAUNCHER,
    clock: time.fake,
    log: out.sink,
  });
  supervisor.start();
  await out.until(() => time.pauses.length >= 4);
  assertEquals(time.pauses, [1_000, 2_000, 4_000, 8_000]);
  assertEquals(pids(out.lines, "back").length, 4);
  assertEquals(pids(out.lines, "mcp"), [supervisor.mcp.pid()]);
  await supervisor.stop();
  // Вывод дочерних — с префиксами, свои строки — со своим.
  assertEquals(out.lines.includes("[back] упал"), true);
  assertEquals(
    out.lines.some((line) => /^\[mcp\] live pid \d+ --port 7339$/.test(line)),
    true,
  );
  assertEquals(
    out.lines.some((line) => /^\[back\] crash pid \d+ --port 7338$/.test(line)),
    true,
  );
  assertEquals(out.lines.includes("[supervisor] старт"), true);
});

Deno.test("SIGUSR1 — новый back, mcp прежний; SIGUSR2 — наоборот; SIGTERM — оба погашены", async () => {
  const time = clock(0);
  const out = log();
  const handlers = new Map<SupervisorSignal, () => void>();
  const running = runSupervisor(["--back", "live", "--mcp", "stubborn"], {
    launcher: LAUNCHER,
    clock: time.fake,
    log: out.sink,
    stdout: () => {},
    onSignal: (signal, handler) => handlers.set(signal, handler),
  });
  const started = (name: string, n: number) =>
    within(
      out.until((lines) => pids(lines, name).length >= n),
      `${n}-й запуск ${name}`,
    );
  /** Дочерний сам сказал, что жив (у упрямого — обработчик стоит). */
  const ready = (prefix: string, n: number) =>
    within(
      out.until((lines) =>
        lines.filter((line) => line.startsWith(prefix)).length >= n
      ),
      `${n}-я строка ${prefix}`,
    );
  await ready("[back] live pid", 1);
  await ready("[mcp] stubborn pid", 1);
  handlers.get("SIGUSR1")?.();
  await started("back", 2);
  assertEquals(pids(out.lines, "mcp").length, 1);
  await ready("[back] live pid", 2);
  handlers.get("SIGUSR2")?.();
  // Упрямый mcp на SIGTERM не отвечает: «прошло 10 с» — SIGKILL.
  await time.expire();
  await started("mcp", 2);
  assertEquals(pids(out.lines, "back").length, 2);
  const [back1, back2] = pids(out.lines, "back");
  const [mcp1, mcp2] = pids(out.lines, "mcp");
  assertEquals(back1 !== back2 && mcp1 !== mcp2, true);
  await ready("[mcp] stubborn pid", 2);
  handlers.get("SIGTERM")?.();
  await time.expire();
  assertEquals(await within(running, "остановка супервизора"), 0);
  assertEquals(
    out.lines.filter((line) =>
      line === "[supervisor] mcp: не ответил на SIGTERM, SIGKILL"
    ).length,
    2,
  );
  for (const pid of [back1, back2, mcp1, mcp2]) {
    assertEquals(alive(pid), false, `pid ${pid} жив`);
  }
});

Deno.test("--version — версия и код 0, ничего не запускается", async () => {
  const printed: string[] = [];
  const code = await runSupervisor(["--version"], {
    launcher: {
      spawn: () => {
        throw new Error("запуск не ожидается");
      },
    },
    clock: clock(0).fake,
    log: { out() {}, err() {} },
    stdout: (text) => void printed.push(text),
    onSignal: () => {},
  });
  assertEquals([code, printed], [0, ["0.1.0\n"]]);
});

Deno.test("неверные флаги — строка использования, код 2, ничего не запускается", async (t) => {
  for (
    const args of [[], ["--back", "a"], ["--back", "a", "--mcp"], [
      "--back",
      "a",
      "--port",
      "b",
    ]]
  ) {
    await t.step(args.join(" ") || "(пусто)", async () => {
      const errors: string[] = [];
      const code = await runSupervisor(args, {
        launcher: {
          spawn: () => {
            throw new Error("запуск не ожидается");
          },
        },
        clock: clock(0).fake,
        log: { out() {}, err: (text) => void errors.push(text) },
        stdout: () => {},
        onSignal: () => {},
      });
      assertEquals(code, 2);
      assertEquals(errors.length, 1);
      assertEquals(errors[0].startsWith("mpu-supervisor: использование"), true);
    });
  }
});
