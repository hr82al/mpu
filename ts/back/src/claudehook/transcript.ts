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

/** `id` блоков `tool_use` записи `assistant`, равных вызову `call`. */
function callIds(record: Fields, call: ToolUse): readonly string[] {
  if (record.type !== "assistant") return [];
  return blocksOf(record).flatMap((block) =>
    block.type === "tool_use" && typeof block.id === "string" &&
      block.name === call.name && same(block.input, call.input)
      ? [block.id]
      : []
  );
}

/** `tool_use_id` ответов `tool_result` записи `user`. */
function resultIds(record: Fields): readonly string[] {
  if (record.type !== "user") return [];
  return blocksOf(record).flatMap((block) =>
    block.type === "tool_result" && typeof block.tool_use_id === "string"
      ? [block.tool_use_id]
      : []
  );
}

/**
 * Где наблюдатель: ищет вызов вопроса, ждёт ответа на него или дождался
 * (спека, «Решено в другом месте» [D.5]). Запись транскрипта переводит
 * состояние дальше — решает само состояние.
 */
interface Watch {
  /** Состояние после записи `record`. */
  take(record: Fields): Watch;
  /** Ответ на вызов вопроса уже в транскрипте. */
  done(): boolean;
}

/** Ответ на вызов вопроса записан; памяти нет — один экземпляр. */
const ANSWERED: Watch = { take: () => ANSWERED, done: () => true };

/** Вызов вопроса известен: ждём `tool_result` с его `id`. */
class Bound implements Watch {
  readonly #id: string;

  constructor(id: string) {
    this.#id = id;
  }

  take(record: Fields): Watch {
    return resultIds(record).includes(this.#id) ? ANSWERED : this;
  }

  done(): boolean {
    return false;
  }
}

/**
 * Вызова вопроса ещё нет: Claude Code зовёт хук раньше, чем пишет
 * `tool_use` (снято 2026-10-06). Первый равный вызову — его.
 */
class Seeking implements Watch {
  readonly #call: ToolUse;

  constructor(call: ToolUse) {
    this.#call = call;
  }

  take(record: Fields): Watch {
    const [id] = callIds(record, this.#call);
    return id === undefined ? this : new Bound(id);
  }

  done(): boolean {
    return false;
  }
}

/**
 * Состояние на момент постановки: самый ранний равный вызову `tool_use`
 * без `tool_result` — вызов вопроса; вызов, уже получивший ответ, — чужой
 * (старый). Открытых нет — вызов ищется в дописанном.
 */
function watchOf(records: readonly Fields[], call: ToolUse): Watch {
  let open: readonly string[] = [];
  for (const record of records) {
    const answered = resultIds(record);
    // Ответ снимает все вхождения id: повтор id в файле не воскрешает
    // отвеченный вызов.
    open = [...open, ...callIds(record, call)].filter((id) =>
      !answered.includes(id)
    );
  }
  return open.length === 0 ? new Seeking(call) : new Bound(open[0]);
}

/** Последние `custom-title` и `ai-title` по записям. */
function titlesOf(
  records: readonly Fields[],
): { readonly custom?: string; readonly ai?: string } {
  let found: { custom?: string; ai?: string } = {};
  for (const record of records) {
    if (
      record.type === "custom-title" && typeof record.customTitle === "string"
    ) {
      found = { ...found, custom: record.customTitle };
    }
    if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      found = { ...found, ai: record.aiTitle };
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

/** Читаемый транскрипт: хвост смотрится до ответа на вызов вопроса. */
class Watched implements Transcript {
  readonly #title: readonly string[];
  readonly #path: string;
  readonly #files: TranscriptFiles;
  readonly #clock: Clock;
  #offset: number;
  #watch: Watch;

  constructor(options: {
    readonly title: readonly string[];
    readonly path: string;
    readonly offset: number;
    /** Состояние на момент постановки. */
    readonly watch: Watch;
    readonly files: TranscriptFiles;
    readonly clock: Clock;
  }) {
    this.#title = options.title;
    this.#path = options.path;
    this.#offset = options.offset;
    this.#watch = options.watch;
    this.#files = options.files;
    this.#clock = options.clock;
  }

  title(): readonly string[] {
    return this.#title;
  }

  async answered(signal: AbortSignal): Promise<void> {
    while (!this.#watch.done()) {
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
    for (const record of records) this.#watch = this.#watch.take(record);
  }
}

/** Файл не читается: ни названия, ни признака ответа. */
const UNREAD: Transcript = { title: () => [], answered: untilAborted };

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
    const titles = titlesOf(records);
    const name = titles.custom ?? titles.ai;
    return new Watched({
      title: name === undefined ? [] : [clipped(name)],
      path,
      offset: used,
      watch: watchOf(records, call),
      files: this.#files,
      clock: this.#clock,
    });
  }
}
