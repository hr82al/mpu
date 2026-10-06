/**
 * Транскрипт сессии Claude Code (`claude-hook-permission-request.md`,
 * «Payload → форма вопроса» [D.9], «Решено в другом месте» [D.5]):
 * название сессии и признак того, что на вопрос ответили в терминале.
 * Файл — JSONL; читается целиком один раз при постановке вопроса, дальше
 * — только дописанный хвост.
 */

import type { Clock } from "../botquestions/mod.ts";
import type { ToolUse } from "./permission.ts";
import { type Fields, isFields } from "./fields.ts";

/** Как часто смотреть хвост: снятие — не позже 2 с после ответа. */
export const WATCH_MS = 1000;

/** Предел названия сессии в заголовке, символов. */
const TITLE_LIMIT = 24;

/** Файлы транскриптов. */
export interface TranscriptFiles {
  /** Файл целиком; нет или не читается — бросает. */
  read(path: string): Promise<Uint8Array>;
  /** Байты с `offset` до конца; не читается — бросает, как `read`. */
  readFrom(path: string, offset: number): Promise<Uint8Array>;
}

/** Файлы диска. */
export const DISK_FILES: TranscriptFiles = {
  read: (path) => Deno.readFile(path),
  async readFrom(path, offset) {
    using file = await Deno.open(path);
    await file.seek(offset, Deno.SeekMode.Start);
    return new Uint8Array(await new Response(file.readable).arrayBuffer());
  },
};

/** Транскрипт глазами вопроса. */
export interface Transcript {
  /** Место «сессия» заголовка: название или пусто. */
  title(): readonly string[];
  /**
   * Решается, когда в транскрипте появился ответ на вызов; иначе ждёт до
   * сигнала и отвергается его причиной.
   */
  answered(signal: AbortSignal): Promise<void>;
}

/** Ждёт только сигнала: признака ответа нет. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

/** Название длиннее предела — 23 символа и `…`; символ — кодовая точка. */
function clipped(title: string): string {
  const points = Array.from(title);
  if (points.length <= TITLE_LIMIT) return title;
  return `${points.slice(0, TITLE_LIMIT - 1).join("")}…`;
}

/** Равенство значений JSON без учёта порядка ключей. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, i) => same(item, b[i]));
  }
  if (isFields(a) && isFields(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return a === b;
}

/** Блоки `message.content` записи. */
function blocksOf(record: Fields): readonly Fields[] {
  const message = record.message;
  if (!isFields(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isFields);
}

/**
 * Полные строки JSONL из байтов: разобранные записи и сколько байтов
 * прочитано до последнего перевода строки — недописанная строка ждёт
 * следующего чтения.
 */
function recordsOf(bytes: Uint8Array): {
  readonly records: readonly Fields[];
  readonly used: number;
} {
  const used = bytes.lastIndexOf(0x0a) + 1;
  const text = new TextDecoder().decode(bytes.subarray(0, used));
  const records: Fields[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isFields(value)) records.push(value);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // Чужая строка не той формы — не наша запись; разбор терпимый.
    }
  }
  return { records, used };
}

/** Ответ на вызов `id` среди записей: `user` с его `tool_result`. */
function answers(records: readonly Fields[], id: string): boolean {
  return records.some((record) =>
    record.type === "user" &&
    blocksOf(record).some((block) =>
      block.type === "tool_result" && block.tool_use_id === id
    )
  );
}

/** Что дал первый, полный, разбор транскрипта. */
interface Scan {
  readonly custom?: string;
  readonly ai?: string;
  /** `id` последнего `tool_use` вызова. */
  readonly id?: string;
}

/** Последние название и `tool_use` вызова `call` по записям. */
function scan(records: readonly Fields[], call: ToolUse): Scan {
  let found: { custom?: string; ai?: string; id?: string } = {};
  for (const record of records) {
    if (
      record.type === "custom-title" && typeof record.customTitle === "string"
    ) {
      found = { ...found, custom: record.customTitle };
    }
    if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      found = { ...found, ai: record.aiTitle };
    }
    if (record.type !== "assistant") continue;
    for (const block of blocksOf(record)) {
      if (
        block.type === "tool_use" && typeof block.id === "string" &&
        block.name === call.name && same(block.input, call.input)
      ) {
        found = { ...found, id: block.id };
      }
    }
  }
  return found;
}

/** Отказ чтения файла: нет его, нет права, это каталог. */
function unreadable(err: unknown): boolean {
  return err instanceof Deno.errors.NotFound ||
    err instanceof Deno.errors.PermissionDenied ||
    err instanceof Deno.errors.IsADirectory;
}

/** Транскрипт с найденным `tool_use`: хвост смотрится до ответа. */
class Watched implements Transcript {
  readonly #title: readonly string[];
  readonly #path: string;
  readonly #id: string;
  readonly #files: TranscriptFiles;
  readonly #clock: Clock;
  #offset: number;
  #seen: boolean;

  constructor(options: {
    readonly title: readonly string[];
    readonly path: string;
    readonly id: string;
    readonly offset: number;
    /** Ответ уже был в первом чтении. */
    readonly seen: boolean;
    readonly files: TranscriptFiles;
    readonly clock: Clock;
  }) {
    this.#title = options.title;
    this.#path = options.path;
    this.#id = options.id;
    this.#offset = options.offset;
    this.#seen = options.seen;
    this.#files = options.files;
    this.#clock = options.clock;
  }

  title(): readonly string[] {
    return this.#title;
  }

  async answered(signal: AbortSignal): Promise<void> {
    while (!this.#seen) {
      await this.#clock.pause(WATCH_MS, signal);
      await this.#look();
    }
  }

  /** Хвост с прошлого чтения: полные строки — в разбор. */
  async #look(): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#files.readFrom(this.#path, this.#offset);
    } catch (err) {
      if (!unreadable(err)) throw err;
      // Файл убрали или отняли право — нового в нём не видно, но и
      // ответа это не значит: вопрос решат чат, срок или обрыв.
      return;
    }
    const { records, used } = recordsOf(bytes);
    this.#offset += used;
    this.#seen = answers(records, this.#id);
  }
}

/** Транскрипт без `tool_use` вызова: снятия по нему нет. */
class Titled implements Transcript {
  readonly #title: readonly string[];

  constructor(title: readonly string[]) {
    this.#title = title;
  }

  title(): readonly string[] {
    return this.#title;
  }

  answered(signal: AbortSignal): Promise<void> {
    return untilAborted(signal);
  }
}

/** Файл не читается: ни названия, ни признака ответа. */
const UNREAD: Transcript = new Titled([]);

/** Транскрипты сессий. */
export class Transcripts {
  readonly #files: TranscriptFiles;
  readonly #clock: Clock;

  constructor(options: {
    readonly files: TranscriptFiles;
    readonly clock: Clock;
  }) {
    this.#files = options.files;
    this.#clock = options.clock;
  }

  /**
   * Транскрипт `path` для вызова `call`: читается целиком один раз.
   * Нечитаемый — без названия и без признака ответа.
   */
  async read(path: string, call: ToolUse): Promise<Transcript> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#files.read(path);
    } catch (err) {
      if (!unreadable(err)) throw err;
      return UNREAD;
    }
    const { records, used } = recordsOf(bytes);
    const found = scan(records, call);
    const name = found.custom ?? found.ai;
    const title = name === undefined ? [] : [clipped(name)];
    if (found.id === undefined) return new Titled(title);
    return new Watched({
      title,
      path,
      id: found.id,
      offset: used,
      seen: answers(records, found.id),
      files: this.#files,
      clock: this.#clock,
    });
  }
}
