/**
 * Настоящие часы и запуск процессов супервизора: `setTimeout` с отменой и
 * `spawn` (`node:child_process`) с выводом построчно.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";
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
async function lines(stream: Readable, line: (text: string) => void) {
  let rest = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) line(part);
  }
  if (rest !== "") line(rest);
}

/**
 * Отказ запуска `command` с причиной. `spawn` сообщает её событием уже
 * после ответа, поэтому она снимается проверкой права на исполнение:
 * «нет файла» (`ENOENT`) и «нет права» (`EACCES`) различимы в журнале.
 */
function spawnRefusal(command: string): Error {
  try {
    accessSync(command, constants.X_OK);
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : "";
    return new Error(`spawn ${command}: ${code}`, { cause: err });
  }
  return new Error(`spawn ${command}`);
}

/** Запуск процессов через `spawn`. */
export const SYSTEM_LAUNCHER: Launcher = {
  spawn(command, args, line) {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid === undefined) {
      // Причину запуска `spawn` сообщает событием позже; без слушателя
      // оно уронило бы процесс, а ответ «не запустился» нужен сейчас.
      child.on("error", () => {});
      throw spawnRefusal(command);
    }
    const output = Promise.all([
      lines(child.stdout, (text) => line("out", text)),
      lines(child.stderr, (text) => line("err", text)),
    ]);
    return {
      pid,
      // Конец — когда кончились и процесс, и его вывод: строка, пришедшая
      // после выхода, не теряется.
      exited: Promise.all([once(child, "exit"), output]).then(() => {}),
      kill(signal) {
        // Кончившийся процесс `kill` не бросает: ответ `false`, гасить
        // нечего.
        child.kill(signal);
      },
    };
  },
};
