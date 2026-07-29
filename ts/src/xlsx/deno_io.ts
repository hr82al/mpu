/**
 * Реальная реализация `XlsxIo` поверх API Deno: файлы, stdin, конфиг-
 * хранилище (0600), запуск открывателя, синхронная запись в потоки.
 * Отделена от main.ts, чтобы тестироваться без запуска бинаря; наружу
 * модуля отдаётся через mod.ts.
 */

import type { XlsxIo } from "./command.ts";
import { FileError, NotFoundIoError } from "./errors.ts";

/** Достаточная часть Deno.stdout/stderr: синхронная запись. */
interface SyncSink {
  writeSync(data: Uint8Array): number;
}

const encoder = new TextEncoder();

/** Полная запись: writeSync может записать буфер частично. */
function writeAllSync(stream: SyncSink, text: string): void {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += stream.writeSync(bytes.subarray(written));
  }
}

function translateNotFound(err: unknown): never {
  if (err instanceof Deno.errors.NotFound) {
    throw new NotFoundIoError("file not found", { cause: err });
  }
  throw err;
}

/**
 * Файл локального хранилища конфига CLI (`~/.config/mpu`, контракт —
 * docs/specs/platform/config.md); без HOME хранилища нет.
 */
export function defaultConfigStorePath(): string | undefined {
  const home = Deno.env.get("HOME");
  if (home === undefined || home === "") return undefined;
  return `${home}/.config/mpu/config.json`;
}

/** Реальные зависимости команды xlsx поверх API Deno. */
export function makeDenoIo(storePath: string | undefined): XlsxIo {
  return {
    env: (name) => Deno.env.get(name),
    cwd: () => Deno.cwd(),
    readFile: async (path) => {
      try {
        return await Deno.readFile(path);
      } catch (err) {
        translateNotFound(err);
      }
    },
    readTextFile: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch (err) {
        translateNotFound(err);
      }
    },
    readTextStdin: () => new Response(Deno.stdin.readable).text(),
    readConfigStore: async () => {
      if (storePath === undefined) return undefined;
      try {
        return await Deno.readTextFile(storePath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return undefined;
        throw err;
      }
    },
    writeConfigStore: async (text) => {
      if (storePath === undefined) {
        // Штатная инфраструктурная ошибка (exit 1), не «unexpected».
        throw new FileError("config store is unavailable (HOME is not set)");
      }
      const dir = storePath.slice(0, storePath.lastIndexOf("/"));
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(storePath, text, { mode: 0o600 });
      // При существующем файле mode из writeTextFile не применяется —
      // права выравниваются явно (зеркалим контракт config.md).
      await Deno.chmod(storePath, 0o600);
    },
    launchOpener: (cmd, target) => {
      try {
        const child = new Deno.Command(cmd, {
          args: [target],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        child.unref();
        return true;
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return false;
        throw err;
      }
    },
    stdout: (text) => writeAllSync(Deno.stdout, text),
    stderr: (text) => writeAllSync(Deno.stderr, text),
  };
}
