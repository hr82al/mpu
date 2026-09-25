/**
 * Решение синхронизации по методу (`image-sync.md`, «Решение по методу»)
 * — из трёх хэшей в одном месте — и план запуска: действия по методам,
 * счёт удалений сторон, отчёт.
 */

import { MethodAddress, type Named } from "./address.ts";
import {
  type BaseMethod,
  type FilesRead,
  type MethodFile,
  NONE,
  type UnreadFile,
} from "./sides.ts";

/** Строка отчёта. */
export class Entry {
  /** 0 — строка метода, 1 — `файл не разобран`: порядок отчёта. */
  readonly group: number;
  /** Ключ порядка внутри группы: метод или путь. */
  readonly order: string;
  readonly text: string;
  /** Строка действия, кроме `конфликт`: входит в «изменено». */
  readonly changed: boolean;
  readonly conflict: boolean;
  /** Строка даёт код 1. */
  readonly failed: boolean;

  constructor(fields: {
    readonly group: number;
    readonly order: string;
    readonly text: string;
    readonly changed?: boolean;
    readonly conflict?: boolean;
    readonly failed?: boolean;
  }) {
    this.group = fields.group;
    this.order = fields.order;
    this.text = fields.text;
    this.changed = fields.changed ?? false;
    this.conflict = fields.conflict ?? false;
    this.failed = fields.failed ?? false;
  }
}

/** Строка действия по методу. */
function actionEntry(word: string, key: string): Entry {
  return new Entry({
    group: 0,
    order: key,
    text: `${word}\t${key}`,
    changed: true,
  });
}

/** Строка `сбой` по методу: сторона не записалась или запретило правило. */
function failureEntry(key: string, reason: string): Entry {
  return new Entry({
    group: 0,
    order: key,
    text: `сбой\t${key}\t${reason}`,
    failed: true,
  });
}

/** Строка `файл не разобран`. */
function unreadEntry(path: string, reason: string): Entry {
  return new Entry({
    group: 1,
    order: path,
    text: `файл не разобран\t${path}\t${reason}`,
    failed: true,
  });
}

/** Исход записи одной стороны по методу. */
export interface Done {
  /**
   * Строка отчёта действия `word` по методу `key`; удалось — сначала
   * `kept` (строка архива).
   */
  entry(word: string, key: string, kept: () => void): Entry;
}

/** Сторона записана. */
export const SUCCEEDED: Done = {
  entry(word, key, kept) {
    kept();
    return actionEntry(word, key);
  },
};

/** Сторона не записана: строка `сбой`. */
export class Failed implements Done {
  readonly #reason: string;

  constructor(reason: string) {
    this.#reason = reason;
  }

  entry(_word: string, key: string): Entry {
    return failureEntry(key, this.#reason);
  }
}

/** Файл не прошёл проверки `define:`: строка `файл не разобран`. */
export class Unparsed implements Done {
  readonly #path: string;
  readonly #reason: string;

  constructor(path: string, reason: string) {
    this.#path = path;
    this.#reason = reason;
  }

  entry(): Entry {
    return unreadEntry(this.#path, this.#reason);
  }
}

/**
 * Кто применяет действия: пишет стороны и архив или только печатает
 * (`dry`). Выбирается один раз на входе.
 */
export interface Applier {
  /** Записать файл метода из базы. */
  writeFile(method: BaseMethod): Promise<Done>;
  removeFile(file: MethodFile): Promise<Done>;
  /**
   * Записать в базу методы из файлов — все этого запуска разом: тело
   * может звать метод, который появляется тут же.
   */
  define(files: readonly MethodFile[]): Promise<ReadonlyMap<string, Done>>;
  forget(method: BaseMethod): Promise<Done>;
  archive(key: string, hash: string): void;
  unarchive(key: string): void;
}

/** Действие по методу. */
export interface Action {
  readonly key: string;
  /** Методы, которые действие пишет в базу из файлов. */
  defining(): readonly MethodFile[];
  /** Удаляет ли метод из базы / файл: счёт предохранителя. */
  deletes(): { readonly base: number; readonly files: number };
  /** Б = Ф до запуска. */
  matched(): boolean;
  /** Строки отчёта. */
  apply(
    applier: Applier,
    defined: ReadonlyMap<string, Done>,
  ): Promise<readonly Entry[]>;
}

const NO_DELETES = { base: 0, files: 0 };

/** Совпало: строки нет; архив — хэш, если он другой. */
class Match implements Action {
  readonly key: string;
  readonly #hash: string;
  readonly #archived: string;

  constructor(key: string, hash: string, archived: string) {
    this.key = key;
    this.#hash = hash;
    this.#archived = archived;
  }

  defining() {
    return [];
  }

  deletes() {
    return NO_DELETES;
  }

  matched() {
    return true;
  }

  apply(applier: Applier) {
    if (this.#hash !== this.#archived) applier.archive(this.key, this.#hash);
    return Promise.resolve([]);
  }
}

/** Нет ни метода, ни файла: строка архива снимается молча. */
class Orphan implements Action {
  readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  defining() {
    return [];
  }

  deletes() {
    return NO_DELETES;
  }

  matched() {
    return false;
  }

  apply(applier: Applier) {
    applier.unarchive(this.key);
    return Promise.resolve([]);
  }
}

/** Файл пишется из базы: `новый файл` или `файл из базы`. */
class ToFile implements Action {
  readonly key: string;
  readonly #word: string;
  readonly #method: BaseMethod;

  constructor(word: string, method: BaseMethod) {
    this.key = method.key;
    this.#word = word;
    this.#method = method;
  }

  defining() {
    return [];
  }

  deletes() {
    return NO_DELETES;
  }

  matched() {
    return false;
  }

  async apply(applier: Applier) {
    const done = await applier.writeFile(this.#method);
    const { key } = this;
    return [
      done.entry(
        this.#word,
        key,
        () => applier.archive(key, this.#method.hash),
      ),
    ];
  }
}

/** База пишется из файла: `новый метод` или `база из файла`. */
class ToBase implements Action {
  readonly key: string;
  readonly #word: string;
  readonly #file: MethodFile;

  constructor(word: string, file: MethodFile) {
    this.key = file.key;
    this.#word = word;
    this.#file = file;
  }

  defining() {
    return [this.#file];
  }

  deletes() {
    return NO_DELETES;
  }

  matched() {
    return false;
  }

  apply(applier: Applier, defined: ReadonlyMap<string, Done>) {
    const done = defined.get(this.key);
    if (done === undefined) {
      // Применитель решает каждый метод, отданный ему на запись.
      throw new Error(`запись в базу не решена: ${this.key}`);
    }
    const { key } = this;
    return Promise.resolve([
      done.entry(this.#word, key, () => applier.archive(key, this.#file.hash)),
    ]);
  }
}

/** Файл удаляется: метода в базе нет, файл не менялся. */
class FileDeleted implements Action {
  readonly key: string;
  readonly #file: MethodFile;

  constructor(file: MethodFile) {
    this.key = file.key;
    this.#file = file;
  }

  defining() {
    return [];
  }

  deletes() {
    return { base: 0, files: 1 };
  }

  matched() {
    return false;
  }

  async apply(applier: Applier) {
    const done = await applier.removeFile(this.#file);
    const { key } = this;
    return [done.entry("удалён файл", key, () => applier.unarchive(key))];
  }
}

/** Метод удаляется из базы: файла нет, метод не менялся. */
class MethodDeleted implements Action {
  readonly key: string;
  readonly #method: BaseMethod;

  constructor(method: BaseMethod) {
    this.key = method.key;
    this.#method = method;
  }

  defining() {
    return [];
  }

  deletes() {
    return { base: 1, files: 0 };
  }

  matched() {
    return false;
  }

  async apply(applier: Applier) {
    const done = await applier.forget(this.#method);
    const { key } = this;
    return [done.entry("удалён метод", key, () => applier.unarchive(key))];
  }
}

/** Конфликт: ни сторона, ни архив не меняются. */
class Conflict implements Action {
  readonly key: string;
  readonly #address: string;

  constructor(named: Named, key: string) {
    this.key = key;
    this.#address = MethodAddress.of(named).text();
  }

  defining() {
    return [];
  }

  deletes() {
    return NO_DELETES;
  }

  matched() {
    return false;
  }

  apply() {
    return Promise.resolve([
      new Entry({
        group: 0,
        order: this.key,
        text: `конфликт\t${this.key}\t${this.#address}`,
        conflict: true,
        failed: true,
      }),
    ]);
  }
}

/** Адреса `base:`/`files:` запуска: какая сторона права в конфликте. */
export interface Preference {
  readonly base: readonly MethodAddress[];
  readonly files: readonly MethodAddress[];
}

/**
 * Конфликт с учётом `base:`/`files:` этого запуска: названный адресом —
 * исход права стороны, иначе строка `конфликт`.
 */
function conflictOf(
  prefer: Preference,
  named: Named,
  key: string,
  onBase: Action,
  onFiles: Action,
): Action {
  if (prefer.base.some((one) => one.names(named))) return onBase;
  if (prefer.files.some((one) => one.names(named))) return onFiles;
  return new Conflict(named, key);
}

/** Метод стороны базы глазами решения. */
interface BaseHeld {
  readonly hash: string;
  readonly named: Named;
  toFile(word: string): Action;
  deleted(): Action;
}

/** Метод стороны файлов глазами решения. */
interface FileHeld {
  readonly hash: string;
  readonly named: Named;
  toBase(word: string): Action;
  deleted(): Action;
}

/** Ни одна строка таблицы не зовёт действие у отсутствующей стороны. */
function unreachable(): never {
  throw new Error("решение позвало действие у отсутствующей стороны");
}

const NOBODY: Named = { receiver: [], name: "" };

/** Метода в базе нет. Null-объект решения. */
const NO_BASE: BaseHeld = {
  hash: NONE,
  named: NOBODY,
  toFile: unreachable,
  deleted: unreachable,
};

/** Файла нет. Null-объект решения. */
const NO_FILE: FileHeld = {
  hash: NONE,
  named: NOBODY,
  toBase: unreachable,
  deleted: unreachable,
};

function baseHeld(method: BaseMethod): BaseHeld {
  return {
    hash: method.hash,
    named: method.method.record(),
    toFile: (word) => new ToFile(word, method),
    deleted: () => new MethodDeleted(method),
  };
}

function fileHeld(file: MethodFile): FileHeld {
  return {
    hash: file.hash,
    named: file,
    toBase: (word) => new ToBase(word, file),
    deleted: () => new FileDeleted(file),
  };
}

/**
 * Действие по методу из трёх хэшей — таблица спеки строка в строку.
 * Отсутствие стороны — `NONE`.
 */
function decide(
  key: string,
  base: BaseHeld,
  file: FileHeld,
  archived: string,
  prefer: Preference,
): Action {
  const b = base.hash;
  const f = file.hash;
  const a = archived;
  if (b !== NONE && f === b) return new Match(key, b, a);
  const named = b !== NONE ? base.named : file.named;
  const conflict = (onBase: Action, onFiles: Action) =>
    conflictOf(prefer, named, key, onBase, onFiles);
  if (a === NONE) {
    if (f === NONE) return base.toFile("новый файл");
    if (b === NONE) return file.toBase("новый метод");
    return conflict(base.toFile("файл из базы"), file.toBase("база из файла"));
  }
  if (b === NONE && f === NONE) return new Orphan(key);
  if (b === NONE) {
    if (f === a) return file.deleted();
    return conflict(file.deleted(), file.toBase("база из файла"));
  }
  if (f === NONE) {
    if (b === a) return base.deleted();
    return conflict(base.toFile("файл из базы"), base.deleted());
  }
  if (f === a) return base.toFile("файл из базы");
  if (b === a) return file.toBase("база из файла");
  return conflict(base.toFile("файл из базы"), file.toBase("база из файла"));
}

/** Удалений на стороне больше половины её методов. */
export interface Overflow {
  readonly deleted: number;
  readonly of: number;
  /** `база` или `файлы`. */
  readonly side: string;
}

/** Итог запуска: строки и числа. */
export class Report {
  readonly #entries: Entry[];
  readonly #matched: number;

  constructor(entries: readonly Entry[], matched: number) {
    this.#entries = [...entries].sort(byGroupAndOrder);
    this.#matched = matched;
  }

  /** Текст отчёта: строки и итог, каждая с переводом строки. */
  text(): string {
    const lines = this.#entries.map((entry) => entry.text);
    const changed = this.#entries.filter((entry) => entry.changed).length;
    const conflicts = this.#entries.filter((entry) => entry.conflict).length;
    lines.push(
      `совпало ${this.#matched}, изменено ${changed}, конфликтов ${conflicts}`,
    );
    return lines.map((line) => `${line}\n`).join("");
  }

  /** 1 — есть `конфликт`, `сбой` или `файл не разобран`; иначе 0. */
  exit(): number {
    return this.#entries.some((entry) => entry.failed) ? 1 : 0;
  }
}

/** Порядок кодовых точек, а не единиц UTF-16. */
function byCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const delta = (a[i].codePointAt(0) ?? 0) - (b[i].codePointAt(0) ?? 0);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function byGroupAndOrder(left: Entry, right: Entry): number {
  return left.group - right.group || byCodePoints(left.order, right.order);
}

/** Стороны и архив до запуска. */
export interface Sides {
  readonly base: readonly BaseMethod[];
  readonly files: FilesRead;
  /** Архив каталога: ключ метода → хэш прошлой синхронизации. */
  readonly archive: ReadonlyMap<string, string>;
}

/** План запуска: действие по каждому методу обеих сторон и архива. */
export class Plan {
  readonly #actions: readonly Action[];
  readonly #unread: readonly UnreadFile[];
  readonly #baseCount: number;
  readonly #fileCount: number;

  constructor(sides: Sides, prefer: Preference) {
    const bases = new Map(sides.base.map((one) => [one.key, one]));
    const files = new Map(sides.files.files.map((one) => [one.key, one]));
    // Неразобранный файл исключён из решения (`image-sync.md`,
    // «Неразобранный файл»): его адрес не считается «файла нет».
    const skipped = new Set(sides.files.unread.map((one) => one.key));
    const keys = new Set([
      ...bases.keys(),
      ...files.keys(),
      ...sides.archive.keys(),
    ]);
    this.#actions = [...keys].filter((key) => !skipped.has(key)).map((key) => {
      const base = bases.get(key);
      const file = files.get(key);
      return decide(
        key,
        base === undefined ? NO_BASE : baseHeld(base),
        file === undefined ? NO_FILE : fileHeld(file),
        sides.archive.get(key) ?? NONE,
        prefer,
      );
    });
    this.#unread = sides.files.unread;
    this.#baseCount = sides.base.length;
    this.#fileCount = sides.files.files.length;
  }

  /**
   * Стороны, на которых удалилось бы больше половины методов
   * (`image-sync.md`, «Предохранители»): база, затем файлы.
   */
  overflows(): readonly Overflow[] {
    const base = this.#actions.reduce((n, one) => n + one.deletes().base, 0);
    const files = this.#actions.reduce((n, one) => n + one.deletes().files, 0);
    return [
      { deleted: base, of: this.#baseCount, side: "база" },
      { deleted: files, of: this.#fileCount, side: "файлы" },
    ].filter((one) => one.deleted * 2 > one.of);
  }

  /** Применяет план применителем `applier`; итог — отчёт. */
  async apply(applier: Applier): Promise<Report> {
    const defined = await applier.define(
      this.#actions.flatMap((action) => action.defining()),
    );
    const entries: Entry[] = this.#unread.map((one) =>
      unreadEntry(one.path, one.reason)
    );
    for (const action of this.#actions) {
      entries.push(...await action.apply(applier, defined));
    }
    const matched = this.#actions.filter((action) => action.matched()).length;
    return new Report(entries, matched);
  }
}
