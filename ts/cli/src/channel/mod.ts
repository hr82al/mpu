/**
 * Команда `mpu claude-channel` (`claude-channel.md`): канал Claude Code
 * для одной сессии — stdio-сервер MCP, который регистрируется в ядре по
 * ключу сессии и пишет в сессию тексты владельца из Telegram. Исполняет
 * клиент; живёт, пока открыт stdin.
 */

import { readMcpLine } from "./mcp.ts";
import { Registration } from "./registration.ts";

/** Слова команды канала: их узнаёт точка входа клиента. */
export const CHANNEL_WORDS: readonly string[] = ["claude-channel"];

/** Что каналу дано снаружи. */
export interface ChannelEnv {
  /** Адрес сервера ядра. */
  readonly base: string;
  /** Основной токен; не читается — `undefined`. */
  readonly mainToken: () => Promise<string | undefined>;
  /** `CLAUDE_CODE_MESSAGING_SOCKET`; нет — `undefined`. */
  readonly key: string | undefined;
  /** Строки stdin по одной; кончаются с закрытием stdin. */
  readonly lines: AsyncIterable<string>;
  /** Запись в stdout; не записалось — отказ. */
  readonly write: (text: string) => Promise<void>;
  readonly stderr: (text: string) => void;
  /** Пауза; прерывается сигналом. */
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Ключа сессии нет: канал запущен не Claude Code. */
const NO_KEY =
  "mpu claude-channel: нет CLAUDE_CODE_MESSAGING_SOCKET — команду запускает Claude Code\n";

/** Записи в stdout — по одной: строки не перемешиваются. */
class Stdout {
  readonly #write: (text: string) => Promise<void>;
  #tail: Promise<void> = Promise.resolve();

  constructor(write: (text: string) => Promise<void>) {
    this.#write = write;
  }

  /** Запись после предыдущих; её отказ — только её. */
  write(text: string): Promise<void> {
    const written = this.#tail.then(() => this.#write(text));
    this.#tail = written.catch(() => {
      // Отказ этой записи отдан её вызывающему; следующая идёт своим ходом.
    });
    return written;
  }
}

/**
 * Канал до закрытия stdin; ответ — код выхода: 0 — сессия кончилась,
 * 1 — ключа сессии нет.
 */
export async function runChannel(env: ChannelEnv): Promise<number> {
  const key = env.key ?? "";
  if (key === "") {
    env.stderr(NO_KEY);
    return 1;
  }
  const stdout = new Stdout(env.write);
  const registration = new Registration({
    base: env.base,
    token: env.mainToken,
    key,
    write: (text) => stdout.write(text),
    stderr: env.stderr,
    pause: env.pause,
  });
  const ended = new AbortController();
  let holding = Promise.resolve();
  for await (const line of env.lines) {
    await readMcpLine(line, {
      // stdout не принял ответ — сессия кончилась, следом закроется и
      // stdin: канал выйдет по нему, а не по сбою записи.
      request: (reply) => stdout.write(reply).catch(() => {}),
      // Повторный `initialized` второй регистрации не заводит.
      initialized: () => {
        holding = holding.then(() => registration.hold(ended.signal));
        return Promise.resolve();
      },
      ignored: () => Promise.resolve(),
    });
  }
  ended.abort();
  await holding;
  return 0;
}
