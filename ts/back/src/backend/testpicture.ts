/**
 * Исполнители стенда картинок (`platform/picture-frame.md`): строку
 * `telegram file` исполняет настоящий код команды на сеансе стенда
 * (`@mpu/cmd-telegram/testing`) и отдаёт ядру кадр `result` по протоколу
 * исполнителя (`platform/line-executor.md`); прочие строки — программы
 * и команды — настоящий исполнитель в памяти.
 */

import {
  type CommandIo,
  DomainError,
  formatCommandError,
  UsageError,
} from "@mpu/command";
import { telegramFileCommand } from "@mpu/cmd-telegram";
import { savedOnStand } from "@mpu/cmd-telegram/testing";
import {
  type Launcher,
  serveOne,
  type Spawned,
  streamWire,
} from "../worker/mod.ts";

/** Провод исполнителя. */
type Wire = Spawned["wire"];

/** Первый pid исполнителей стенда — далеко от исполнителей в памяти. */
const FIRST_PID = 9000;

/** Провод в памяти: что послал один конец, читает другой. */
function wires(): { readonly host: Wire; readonly worker: Wire } {
  const down = new TransformStream<Uint8Array, Uint8Array>();
  const up = new TransformStream<Uint8Array, Uint8Array>();
  return {
    host: streamWire(up.readable, down.writable),
    worker: streamWire(down.readable, up.writable),
  };
}

/** Аргументы строки `telegram file` из первого кадра; иная — `undefined`. */
function telegramArgs(line: string): readonly string[] | undefined {
  const frame: unknown = JSON.parse(line);
  if (typeof frame !== "object" || frame === null || !("run" in frame)) {
    return undefined;
  }
  const { run } = frame;
  if (typeof run !== "object" || run === null) return undefined;
  if (!("path" in run) || !("args" in run)) return undefined;
  if (JSON.stringify(run.path) !== '["telegram","file"]') return undefined;
  return Array.isArray(run.args) ? run.args.map(String) : undefined;
}

/**
 * Исход `telegram file` на стенде — тем же переводом ошибок, что у
 * настоящего исполнителя: отказ ввода — код 2, отказ команды — код 1.
 */
async function outcomeOf(
  args: readonly string[],
  io: CommandIo,
  dir: string,
): Promise<unknown> {
  const command = telegramFileCommand;
  try {
    return { value: await savedOnStand(command.parseArgs(args), io, dir) };
  } catch (err) {
    if (err instanceof UsageError) {
      return { code: 2, stderr: formatCommandError(command.errorName, err) };
    }
    if (err instanceof DomainError) {
      return { code: 1, stderr: formatCommandError(command.errorName, err) };
    }
    throw err;
  }
}

/** Исполнитель стенда: первый кадр решает, кто отвечает. */
async function serveStand(wire: Wire, io: CommandIo, dir: string) {
  const lines = wire.lines()[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done === true) return await wire.close();
  const args = telegramArgs(first.value);
  if (args !== undefined) {
    const result = await outcomeOf(args, io, dir);
    await wire.send(`${JSON.stringify({ result })}\n`);
    return await wire.close();
  }
  // Прочая строка — настоящему исполнителю, вместе с прочитанным кадром.
  const replayed: Wire = {
    lines: async function* () {
      yield first.value;
      for (let next = await lines.next(); next.done !== true; ) {
        yield next.value;
        next = await lines.next();
      }
    },
    send: (text) => wire.send(text),
    close: () => wire.close(),
  };
  await serveOne(replayed, io, () => {});
}

/** Исполнители стенда картинок: файлы `telegram file` — в `dir`. */
export class PictureLauncher implements Launcher {
  readonly #io: CommandIo;
  readonly #dir: string;
  #pid = FIRST_PID;

  constructor(io: CommandIo, dir: string) {
    this.#io = io;
    this.#dir = dir;
  }

  launch(): Spawned {
    const { host, worker } = wires();
    const status = serveStand(worker, this.#io, this.#dir).then(
      () => ({ code: 0, signal: null }),
      () => ({ code: 1, signal: null }),
    );
    return {
      pid: this.#pid++,
      startedAt: Date.now(),
      wire: host,
      status,
      kill() {
        Promise.all([worker.close(), host.close()]).catch(() => {
          // Провод уже закрыт — рвать нечего.
        });
      },
    };
  }
}
