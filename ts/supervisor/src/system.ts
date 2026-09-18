/**
 * Настоящие часы и запуск процессов супервизора: `setTimeout` с отменой и
 * `Deno.Command` с выводом построчно.
 */

import type { Clock, Launcher } from "./child.ts";

/** Часы процесса. */
export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    }),
};

/** Поток дочернего — построчно в `line`. */
async function lines(
  stream: ReadableStream<Uint8Array>,
  line: (text: string) => void,
) {
  let rest = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) line(part);
  }
  if (rest !== "") line(rest);
}

/** Запуск процессов через `Deno.Command`. */
export const SYSTEM_LAUNCHER: Launcher = {
  spawn(command, args, line) {
    const child = new Deno.Command(command, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = Promise.all([
      lines(child.stdout, (text) => line("out", text)),
      lines(child.stderr, (text) => line("err", text)),
    ]);
    return {
      pid: child.pid,
      // Конец — когда кончились и процесс, и его вывод: строка, пришедшая
      // после выхода, не теряется.
      exited: Promise.all([child.status, output]).then(() => {}),
      kill(signal) {
        try {
          child.kill(signal);
        } catch (err) {
          // Процесс уже кончился — гасить нечего.
          if (!(err instanceof TypeError)) throw err;
        }
      },
    };
  },
};
