/**
 * Файл образа (`platform/image.md`, «Хранение»): SQLite `image.db` рядом с
 * `policy.db`, прочитанные методы и их сверка с файлом перед каждым
 * чтением.
 */

import { DatabaseSync } from "node:sqlite";
import { BUSY_TIMEOUT_MS } from "../store/mod.ts";
import { ImageMethod } from "./method.ts";

/** Файл образа нельзя открыть, прочитать или записать: готовый отказ строки. */
export class ImageError extends Error {
  override name = "ImageError";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS methods (
  receiver TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  words TEXT NOT NULL,
  purpose TEXT NOT NULL,
  keys TEXT NOT NULL,
  author TEXT NOT NULL,
  time TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (receiver, name)
);`;

/** Файл ещё не открыт: его нет или его ещё не спрашивали. */
interface Shelf {
  /** Методы файла, каким он стал к этому моменту. */
  methods(): readonly ImageMethod[];
  /** Соединение для записи; файла нет — создать. */
  writable(): Opened;
  close(): void;
}

/** Каталога состояния нет: образ пуст, записать некуда. */
const HOMELESS: Shelf = {
  methods: () => [],
  writable: () => {
    throw new ImageError("образ: каталог состояния не задан (нет HOME)");
  },
  close() {},
};

/** Открытый файл: соединение, прочитанное и версия, из которой оно. */
class Opened implements Shelf {
  readonly #db: DatabaseSync;
  #methods: readonly ImageMethod[] = [];
  /** Версия файла, из которой прочитан `#methods` (`PRAGMA data_version`). */
  #version = -1;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Соединение со схемой; схема не создалась — соединение закрыто. */
  static open(file: string): Opened {
    const db = new DatabaseSync(file);
    try {
      // Ожидание чужой записи — внутри SQLite, как у файла правил.
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec(SCHEMA);
    } catch (err) {
      db.close();
      throw err;
    }
    return new Opened(db);
  }

  methods(): readonly ImageMethod[] {
    if (this.#fileVersion() !== this.#version) this.#load();
    return this.#methods;
  }

  writable(): Opened {
    return this;
  }

  /** Записывает метод (заменяет прежний того же имени у того же получателя). */
  define(method: ImageMethod) {
    const record = method.record();
    this.#db.prepare(
      `INSERT OR REPLACE INTO methods
         (receiver, name, source, words, purpose, keys, author, time, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.receiver.join(" "),
      record.name,
      method.text(),
      JSON.stringify(record.words),
      record.purpose,
      record.keys,
      record.author,
      record.time,
      method.hash(),
    );
    this.#load();
  }

  /** Удаляет метод; итог — был ли он. */
  forget(receiver: readonly string[], name: string): boolean {
    const { changes } = this.#db.prepare(
      "DELETE FROM methods WHERE receiver = ? AND name = ?",
    ).run(receiver.join(" "), name);
    this.#load();
    return Number(changes) > 0;
  }

  close() {
    this.#db.close();
  }

  #load() {
    // Версия — до чтения строк: чужая запись между ними оставит
    // прочитанное с устаревшей версией, и следующее чтение его перечитает.
    const version = this.#fileVersion();
    const rows = this.#db.prepare(
      "SELECT receiver, name, words, purpose, keys, author, time FROM methods" +
        " ORDER BY receiver, name",
    ).all();
    this.#methods = rows.map((row) =>
      new ImageMethod({
        receiver: String(row.receiver).split(" "),
        name: String(row.name),
        words: wordsOf(String(row.words)),
        purpose: String(row.purpose),
        keys: String(row.keys),
        author: String(row.author),
        time: String(row.time),
      })
    );
    this.#version = version;
  }

  /** Версия файла глазами соединения: меняет её чужая запись. */
  #fileVersion(): number {
    return Number(this.#db.prepare("PRAGMA data_version").get()?.data_version);
  }
}

/** Слова исходника из строки файла. */
function wordsOf(json: string): string[] {
  const words: unknown = JSON.parse(json);
  if (!Array.isArray(words) || !words.every((w) => typeof w === "string")) {
    throw new Error("исходник метода — не список слов");
  }
  return words;
}

/** Файл есть, но ещё не открыт: откроется, когда его спросят. */
class Closed implements Shelf {
  readonly #file: string;
  readonly #opened: (opened: Opened) => void;

  constructor(file: string, opened: (opened: Opened) => void) {
    this.#file = file;
    this.#opened = opened;
  }

  /** Файла нет — пусто; появился — открывается и читается. */
  methods(): readonly ImageMethod[] {
    if (!exists(this.#file)) return [];
    return this.#open().methods();
  }

  writable(): Opened {
    const cut = this.#file.lastIndexOf("/");
    if (cut > 0) Deno.mkdirSync(this.#file.slice(0, cut), { recursive: true });
    return this.#open();
  }

  close() {}

  #open(): Opened {
    const opened = Opened.open(this.#file);
    this.#opened(opened);
    return opened;
  }
}

function exists(file: string): boolean {
  try {
    Deno.statSync(file);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** Образ: методы пользователя в файле, сверенные с ним перед чтением. */
export class Image implements Disposable {
  #shelf: Shelf;

  private constructor(file: string | undefined) {
    this.#shelf = file === undefined
      ? HOMELESS
      : new Closed(file, (opened) => this.#shelf = opened);
  }

  /**
   * Образ файла `file`. Ничего не открывает и не создаёт: файл читается
   * первым вопросом, создаётся первой записью.
   *
   * @param file путь `image.db`; `undefined` — каталога состояния нет
   */
  static at(file: string | undefined): Image {
    return new Image(file);
  }

  /**
   * Методы образа по получателю и имени — по файлу, каким он стал к
   * этому моменту.
   *
   * @throws ImageError — файл не открылся или не читается
   */
  methods(): readonly ImageMethod[] {
    return guarded(() => this.#shelf.methods());
  }

  /**
   * Записывает метод сразу (транзакцией одной строки).
   *
   * @throws ImageError — записать некуда или нельзя
   */
  define(method: ImageMethod) {
    guarded(() => this.#shelf.writable().define(method));
  }

  /**
   * Удаляет метод; итог — был ли он.
   *
   * @throws ImageError — файл нельзя изменить
   */
  forget(receiver: readonly string[], name: string): boolean {
    return guarded(() => this.#shelf.writable().forget(receiver, name));
  }

  [Symbol.dispose]() {
    this.#shelf.close();
  }
}

/** Любой сбой файла образа — отказ строки с причиной. */
function guarded<T>(act: () => T): T {
  try {
    return act();
  } catch (err) {
    if (err instanceof ImageError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ImageError(`образ: ${reason}`, { cause: err });
  }
}
