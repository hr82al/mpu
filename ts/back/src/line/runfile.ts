/**
 * Программа из файла `mpu run: x.mpu col: review`
 * (`platform/program-input.md`, «`run:`», «Файл программы», «Параметры»):
 * разбор набранной строки на путь и ключи-параметры, проверки пути до
 * чтения — в названном спекой порядке, чтение и слова текста.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { configHomeDir } from "@mpu/command/env";
import { NotUtf8, utf8Of, wordsOf } from "@mpu/language/frames";
import { ASK_WORD, GRAMMAR, MessageParseError } from "@mpu/language/messages";
import { hasErrorCode } from "@mpu/base/oserror";
import {
  type Doc,
  keyword,
  LISTED,
  type Method,
  NO_HINT,
  Refusal,
  RefusalNotice,
  type Refused,
} from "@mpu/language/objects";
import { Misstep, textAt } from "@mpu/language/program";
import type { Line } from "./dispatch.ts";
import type { LineStdin } from "./value.ts";

/** Расширение файла программы — одно для отказа и справки. */
const EXTENSION = ".mpu";

/** Справка `run:`: однострока и когда звать. */
export const RUN_DOC: Doc = {
  purpose: `исполнить программу из файла ${EXTENSION}`,
  help:
    "Звать, когда программа длиннее строки или ломается на кавычках " +
    "оболочки:\nфайл делится по пробелам так же, как строка, а @ключ " +
    "внутри берёт значение\nиз ключа вызова (mpu run: x.mpu col: review). " +
    "Без слов программа берётся\nиз stdin: mpu < x.mpu.",
};

/** Текст `mpu run: help`. */
export function runHelp(): string {
  return (
    `Использование: mpu ${GRAMMAR.run} <файл${EXTENSION}> ` +
    `[<ключ>: <значение>]…\n\n${RUN_DOC.purpose}\n\n${RUN_DOC.help}\n`
  );
}

/** Вид и текст отказа `run:` не первым словом строки. */
const NOT_FIRST = `${GRAMMAR.run} не первым словом`;
const NOT_FIRST_TEXT = `${GRAMMAR.run} — только первым словом строки`;

/**
 * `run:` корня и двери — справка и дополнение. Исполняется оно, только
 * если строка не начата им (группа значения `do run: x.mpu end`): такой
 * `run:` — не источник, а отказ.
 */
export function runMethod(): Method<Line> {
  return keyword({ run: "value" }, ["run"], RUN_DOC, LISTED, () => {
    throw new Refusal(NOT_FIRST_TEXT, { reason: NOT_FIRST });
  });
}

/** Файловая система и каталоги настроек, которых программа не читает. */
export interface ProgramFiles {
  /** Каталоги настроек mpu окружения сервера строк, как набраны. */
  readonly settings: readonly string[];
  /** Реальный путь: ссылки раскрыты; нет пути — ошибка `ENOENT`. */
  realPath(path: string): Promise<string>;
  /** Файл ли это и сколько у него жёстких ссылок. */
  stat(path: string): Promise<{ isFile: boolean; nlink: number | null }>;
  read(path: string): Promise<Uint8Array>;
}

/**
 * Файлы программ по окружению СЕРВЕРА строк: каталог токенов
 * `$HOME/.config/mpu` и каталог `.env` (`$XDG_CONFIG_HOME/mpu`).
 */
export function programFiles(
  readEnv: (name: string) => string | undefined,
): ProgramFiles {
  const home = readEnv("HOME");
  const dirs = [
    ...(home === undefined || home === "" ? [] : [`${home}/.config/mpu`]),
    ...[configHomeDir(readEnv)].filter((dir) => dir !== undefined),
  ];
  return {
    settings: [...new Set(dirs)],
    realPath: (path) => realpath(path),
    stat: async (path) => {
      const found = await stat(path);
      return { isFile: found.isFile(), nlink: found.nlink };
    },
    read: async (path) => new Uint8Array(await readFile(path)),
  };
}

/** Отказ источника: вид и текст — за префиксом источника. */
export class SourceError extends Error {
  override name = "SourceError";
  readonly reason: string;

  constructor(reason: string, text: string) {
    super(text);
    this.reason = reason;
  }

  /** Отказ объектом: текст — за именем источника `source`, подсказки нет. */
  refused(source: string): Refused {
    return new RefusalNotice({
      reason: this.reason,
      said: `${source}: ${this.message}`,
      hint: NO_HINT,
      candidates: [],
    });
  }
}

const NOT_PROGRAM = `программа — файл ${EXTENSION}`;
const SETTINGS = "каталог настроек не читается";
const SETTINGS_TEXT = "каталог настроек mpu программой не читается";
const NO_FILE = "нет файла";
const NO_READ = "нет права чтения";

/** Путь без `.` и `..`, от корня. */
function normalized(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** Последний сегмент пути кончается на `.mpu`. */
function isProgramPath(path: string): boolean {
  return (path.split("/").at(-1) ?? "").endsWith(EXTENSION);
}

/** Лежит ли `path` в одном из каталогов `dirs` (или совпадает с ним). */
function within(path: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** Реальный путь; отказ ФС — отказ источника о пути `full`. */
async function realOf(files: ProgramFiles, full: string): Promise<string> {
  try {
    return await files.realPath(full);
  } catch (err) {
    if (hasErrorCode(err, "EACCES", "EPERM")) {
      throw new SourceError(NO_READ, `${NO_READ} ${full}`);
    }
    if (hasErrorCode(err, "ENOENT", "ENOTDIR")) {
      throw new SourceError(NO_FILE, `${NO_FILE} ${full}`);
    }
    throw err;
  }
}

/**
 * Каталоги настроек как набраны и их реальные пути: ссылка на каталог
 * (`~/.config` → другой диск) не уводит токен из-под проверки.
 */
async function settingsOf(files: ProgramFiles): Promise<string[]> {
  const real = await Promise.all(
    files.settings.map(async (dir) => {
      try {
        return [await files.realPath(dir)];
      } catch (err) {
        // Каталога нет или его не пройти — остаётся проверка по набранному.
        if (hasErrorCode(err, "ENOENT", "ENOTDIR", "EACCES", "EPERM"))
          return [];
        throw err;
      }
    }),
  );
  return [...files.settings, ...real.flat()];
}

/**
 * Байты файла программы: восемь проверок до чтения в порядке спеки.
 *
 * @param typed путь, как набран
 * @param cwd каталог строки — от него относительный путь
 * @throws SourceError — отказ пути
 */
async function programBytes(
  typed: string,
  cwd: string,
  files: ProgramFiles,
): Promise<Uint8Array> {
  if (!isProgramPath(typed)) throw new SourceError(NOT_PROGRAM, NOT_PROGRAM);
  const full = normalized(typed.startsWith("/") ? typed : `${cwd}/${typed}`);
  if (within(full, files.settings)) {
    throw new SourceError(SETTINGS, SETTINGS_TEXT);
  }
  const real = await realOf(files, full);
  if (within(real, await settingsOf(files))) {
    throw new SourceError(SETTINGS, SETTINGS_TEXT);
  }
  if (!isProgramPath(real)) {
    throw new SourceError(
      NOT_PROGRAM,
      `${NOT_PROGRAM}, а ${full} ведёт в ${real}`,
    );
  }
  const stat = await files.stat(real);
  if (!stat.isFile) throw new SourceError("не файл", `не файл ${full}`);
  if ((stat.nlink ?? 1) > 1) {
    throw new SourceError(
      "несколько ссылок",
      "у файла несколько ссылок — программой не читается",
    );
  }
  try {
    return await files.read(real);
  } catch (err) {
    if (!hasErrorCode(err, "EACCES", "EPERM")) throw err;
    throw new SourceError(NO_READ, `${NO_READ} ${full}`);
  }
}

/** Слова файла: UTF-8, BOM снят; начальный `ask` — дверь, а не слово. */
function programWords(bytes: Uint8Array): {
  readonly words: readonly string[];
  readonly door: boolean;
} {
  let text: string;
  try {
    text = utf8Of(bytes);
  } catch (err) {
    if (!(err instanceof NotUtf8)) throw err;
    throw new SourceError("файл не в UTF-8", `файл ${err.message}`);
  }
  const words = wordsOf(text);
  const door = words[0] === ASK_WORD;
  const program = door ? words.slice(1) : words;
  if (program.length === 0) {
    throw new SourceError("программа пуста", "программа пуста");
  }
  return { words: program, door };
}

/** Значение ключа-параметра с позиции `at`: слово, `^…^`, `-- x`, `stdin`. */
async function paramValue(
  said: readonly string[],
  at: number,
  key: string,
  stdin: LineStdin,
): Promise<{ readonly value: string; readonly next: number }> {
  const word = said[at];
  if (word === undefined || isKeyWord(word)) {
    const missing = MessageParseError.noValue(key);
    throw new SourceError(missing.reason, missing.message);
  }
  if (word === GRAMMAR.literal) {
    if (at + 1 >= said.length) {
      throw new SourceError(NO_WORD, NO_WORD);
    }
    return { value: said[at + 1], next: at + 2 };
  }
  if (word === GRAMMAR.stdin) {
    return { value: await taken(stdin, key), next: at + 1 };
  }
  if (word.startsWith(GRAMMAR.quote)) {
    try {
      const { text, next } = textAt(said, at, said.length);
      return { value: text, next };
    } catch (err) {
      if (!(err instanceof Misstep)) throw err;
      throw new SourceError(err.refusal.reason, err.refusal.message);
    }
  }
  return { value: word, next: at + 1 };
}

/** Ввод строки значением ключа `key`; терминал — отказ. */
async function taken(stdin: LineStdin, key: string): Promise<string> {
  try {
    // Ключ без своего приглашения: терминал — отказ, а не `undefined`.
    return (await stdin.take(key, false)) ?? "";
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    throw new SourceError(err.reason, err.message);
  }
}

const NO_WORD = `после ${GRAMMAR.literal} нет слова`;

/** Слово-ключ набранной строки: `col:` или `--col`. */
function isKeyWord(word: string): boolean {
  return keyOf(word) !== "";
}

/** Имя ключа слова; не ключ — пусто. */
function keyOf(word: string): string {
  if (word.length > 1 && word.endsWith(GRAMMAR.parameter)) {
    return word.slice(0, -GRAMMAR.parameter.length);
  }
  if (word.startsWith("--") && word.length > 2) return word.slice(2);
  return "";
}

/** Параметры набранной строки после пути: имя → значение. */
async function paramsOfLine(
  said: readonly string[],
  stdin: LineStdin,
): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  let at = 2;
  while (at < said.length) {
    const key = keyOf(said[at]);
    if (key === "") {
      throw new SourceError("не понимает", `не понимает ${said[at]}`);
    }
    const { value, next } = await paramValue(said, at + 1, key, stdin);
    values.set(key, value);
    at = next;
  }
  return values;
}

/** Файл программы, прочитанный и проверенный. */
export interface ProgramFile {
  readonly words: readonly string[];
  /** Текст начат `ask`: строка идёт дверью. */
  readonly door: boolean;
  readonly params: ReadonlyMap<string, string>;
}

/**
 * Программа строки `run: <путь> [ключ: значение]…`: путь проверяется и
 * читается раньше, чем ключи берут ввод строки.
 *
 * @param said набранные слова без двери; первое — `run:`, второе — путь
 * @param cwd каталог строки
 * @param stdin ввод строки: из него берёт значение ключ `stdin`
 * @throws SourceError — отказ пути, текста или ключей
 */
export async function programFile(
  said: readonly string[],
  cwd: string,
  files: ProgramFiles,
  stdin: LineStdin,
): Promise<ProgramFile> {
  const bytes = await programBytes(said[1], cwd, files);
  const { words, door } = programWords(bytes);
  return { words, door, params: await paramsOfLine(said, stdin) };
}
