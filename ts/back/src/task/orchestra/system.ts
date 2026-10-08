/**
 * Настоящие порты оркестратора (`task-orchestrator.md`, «Порты и права»):
 * окна — программой `/usr/bin/tmux`, уведомления — строкой лога и
 * `/usr/bin/notify-send`, файлы первых сообщений — на диск. Программы —
 * абсолютными путями: права Deno перечисляют их литералами.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { hasErrorCode } from "@mpu/base/oserror";
import { runProgram } from "@mpu/subprocess";
import type { Letters, Notices, Place, Windows } from "./ports.ts";

export const TMUX = "/usr/bin/tmux";
export const NOTIFY_SEND = "/usr/bin/notify-send";

/** Итог запуска программы. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Запуск программы с аргументами до её конца. */
export type Run = (program: string, args: readonly string[]) => Promise<Ran>;

/** Запуск подпроцессом. */
export const SYSTEM_RUN: Run = async (program, args) => {
  const out = await runProgram(program, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
};

/** Сбой команды tmux: код и её stderr. */
export class TmuxError extends Error {
  override name = "TmuxError";
}

/** Окна tmux: каждая операция — одна команда `tmux`. */
export class TmuxWindows implements Windows {
  readonly #run: Run;

  constructor(run: Run) {
    this.#run = run;
  }

  async hasSession(session: string): Promise<boolean> {
    const ran = await this.#run(TMUX, ["has-session", "-t", `=${session}`]);
    return ran.code === 0;
  }

  async newSession(place: Place, dir: string): Promise<void> {
    await this.#must([
      "new-session",
      "-d",
      "-s",
      place.session,
      "-n",
      place.window,
      "-c",
      dir,
    ]);
  }

  async newWindow(place: Place, dir: string): Promise<void> {
    await this.#must([
      "new-window",
      "-d",
      "-t",
      `=${place.session}:`,
      "-n",
      place.window,
      "-c",
      dir,
    ]);
  }

  /** Окна или сессии нет, сервер не запущен — `undefined`. */
  async command(place: Place): Promise<string | undefined> {
    const ran = await this.#run(TMUX, [
      "display-message",
      "-p",
      "-t",
      targetOf(place),
      "#{pane_current_command}",
    ]);
    if (ran.code !== 0) return undefined;
    return ran.stdout.trim();
  }

  screen(place: Place): Promise<string> {
    return this.#must(["capture-pane", "-p", "-t", targetOf(place)]);
  }

  async type(place: Place, text: string): Promise<void> {
    await this.#must(["send-keys", "-t", targetOf(place), "-l", "--", text]);
  }

  async enter(place: Place): Promise<void> {
    await this.#must(["send-keys", "-t", targetOf(place), "Enter"]);
  }

  async close(place: Place): Promise<void> {
    await this.#must(["kill-window", "-t", targetOf(place)]);
  }

  async #must(args: readonly string[]): Promise<string> {
    const ran = await this.#run(TMUX, args);
    if (ran.code !== 0) {
      throw new TmuxError(`tmux ${args[0]}: ${ran.stderr.trim()}`);
    }
    return ran.stdout;
  }
}

/** Точное имя окна: `=сессия:=окно` — без поиска по префиксу. */
function targetOf(place: Place): string {
  return `=${place.session}:=${place.window}`;
}

/**
 * Уведомления службы: строка в лог и `notify-send`. Программы нет —
 * остаётся строка лога (решение хоста T3); прочий сбой — тоже строкой.
 */
export class SystemNotices implements Notices {
  readonly #line: (text: string) => void;
  readonly #run: Run;

  constructor(line: (text: string) => void, run: Run) {
    this.#line = line;
    this.#run = run;
  }

  async notify(text: string): Promise<void> {
    this.#line(text);
    try {
      await this.#run(NOTIFY_SEND, ["mpu task", text]);
    } catch (err) {
      if (hasErrorCode(err, "ENOENT")) return;
      const reason = err instanceof Error ? err.message : String(err);
      this.#line(`notify-send: ${reason}`);
    }
  }

  log(text: string): Promise<void> {
    this.#line(text);
    return Promise.resolve();
  }
}

/** Файлы первых сообщений: каталог создаётся, файл перезаписывается. */
export const SYSTEM_LETTERS: Letters = {
  write: async (path, text) => {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, text);
  },
};
