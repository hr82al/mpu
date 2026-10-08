/**
 * Стороны синхронизации (`image-sync.md`): методы базы и файлы каталога
 * образа. У каждого метода стороны — ключ (получатель и имя, как их
 * печатает отчёт) и хэш строки определения.
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import {
  blockParams,
  canonicalLine,
  DEFINE,
  isPlain,
  saidOf,
  storedName,
} from "./definition.ts";
import type { ImageMethod } from "./method.ts";
import { NotUtf8, utf8Of, wordsOf } from "../frames/mod.ts";
import { hasErrorCode } from "@mpu/base/oserror";

/** Хэш отсутствующей стороны — null-объект решения: sha256 пустым не бывает. */
export const NONE = "";

/** Расширение файла метода. */
const EXTENSION = ".mpu";

/** sha256 строки определения, hex. */
export function lineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}

/** Ключ метода: получатель и имя через пробел — так его печатает отчёт. */
export function keyOf(receiver: readonly string[], name: string): string {
  return [...receiver, name].join(" ");
}

/** Метод стороны базы. */
export class BaseMethod {
  readonly method: ImageMethod;
  readonly key: string;
  readonly hash: string;

  constructor(method: ImageMethod) {
    const { receiver, name } = method.record();
    this.method = method;
    this.key = keyOf(receiver, name);
    this.hash = lineHash(method.definition());
  }
}

/** Разобранный файл метода. */
export class MethodFile {
  readonly key: string;
  /** Путь от каталога образа. */
  readonly path: string;
  readonly receiver: readonly string[];
  readonly name: string;
  /** Слова строки определения, как в файле. */
  readonly words: readonly string[];
  /** Тело — блок `do … done`, как в файле. */
  readonly body: readonly string[];
  readonly hash: string;

  constructor(parts: {
    readonly path: string;
    readonly receiver: readonly string[];
    readonly name: string;
    readonly words: readonly string[];
    readonly body: readonly string[];
    readonly line: string;
  }) {
    this.key = keyOf(parts.receiver, parts.name);
    this.path = parts.path;
    this.receiver = [...parts.receiver];
    this.name = parts.name;
    this.words = [...parts.words];
    this.body = [...parts.body];
    this.hash = lineHash(parts.line);
  }

  sortInto(sorted: Sorted) {
    sorted.files.push(this);
  }
}

/**
 * Неразобранный файл: адрес — из пути; в решение не входит, отвечает
 * строкой `файл не разобран` (`image-sync.md`, «Неразобранный файл»).
 */
export class UnreadFile {
  readonly key: string;
  readonly path: string;
  readonly reason: string;

  constructor(key: string, path: string, reason: string) {
    this.key = key;
    this.path = path;
    this.reason = reason;
  }

  sortInto(sorted: Sorted) {
    sorted.unread.push(this);
  }
}

/** Файлы каталога по видам, пока их читают. */
interface Sorted {
  readonly files: MethodFile[];
  readonly unread: UnreadFile[];
}

/** Каталог образа или файл в нём не читается: причина от ОС. */
export class UnreadableDir extends Error {
  override name = "UnreadableDir";
}

/** Ошибка файловой системы — `UnreadableDir` с причиной. */
function unreadable(err: unknown): UnreadableDir {
  if (!(err instanceof Error)) throw err;
  return new UnreadableDir(err.message, { cause: err });
}

/** Кто может быть получателем метода: команда или группа дерева. */
export interface Receivers {
  known(receiver: readonly string[]): boolean;
  /** Отказ `define:` получателю не из дерева — текстом. */
  refusal(receiver: readonly string[]): string;
}

/** Файлы каталога образа: разобранные и нет. */
export interface FilesRead {
  readonly files: readonly MethodFile[];
  readonly unread: readonly UnreadFile[];
}

/**
 * Файлы методов каталога `dir` со всеми подкаталогами; прочие файлы не
 * читаются. Каталога нет — пусто.
 *
 * @throws UnreadableDir — каталог есть, но он или файл в нём не читается
 */
export function readFiles(dir: string, receivers: Receivers): FilesRead {
  const sorted: Sorted = { files: [], unread: [] };
  for (const path of methodPaths(dir, "")) {
    readFile(dir, path, receivers).sortInto(sorted);
  }
  return sorted;
}

/** Пути файлов методов под `dir/sub` от `dir`. */
function methodPaths(dir: string, sub: string): string[] {
  const at = sub === "" ? dir : `${dir}/${sub}`;
  let entries: Dirent[];
  try {
    entries = readdirSync(at, { withFileTypes: true });
  } catch (err) {
    if (sub === "" && hasErrorCode(err, "ENOENT")) return [];
    throw unreadable(err);
  }
  return entries.flatMap((entry) => {
    const path = sub === "" ? entry.name : `${sub}/${entry.name}`;
    if (entry.isDirectory()) return methodPaths(dir, path);
    return entry.isFile() && entry.name.endsWith(EXTENSION) ? [path] : [];
  });
}

/** Файл метода по пути от каталога: разобран или нет. */
function readFile(
  dir: string,
  path: string,
  receivers: Receivers,
): MethodFile | UnreadFile {
  const links = path.split("/");
  const receiver = links.slice(0, -1);
  const name = links[links.length - 1].slice(0, -EXTENSION.length);
  const key = keyOf(receiver, name);
  if (!receivers.known(receiver)) {
    return new UnreadFile(key, path, receivers.refusal(receiver));
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(`${dir}/${path}`));
  } catch (err) {
    throw unreadable(err);
  }
  let words: string[];
  try {
    words = wordsOf(utf8Of(bytes));
  } catch (err) {
    if (err instanceof NotUtf8) {
      return new UnreadFile(key, path, `файл ${err.message}`);
    }
    throw err;
  }
  return parsed(words, { key, path, receiver, name });
}

/** Где файл лежит и что по пути в нём ждут. */
interface Expected {
  readonly key: string;
  readonly path: string;
  readonly receiver: readonly string[];
  readonly name: string;
}

/** Строка определения файла, сверенная с путём. */
function parsed(
  words: readonly string[],
  expected: Expected,
): MethodFile | UnreadFile {
  const { key, path } = expected;
  const at = words.indexOf(DEFINE);
  const receiver = words.slice(0, Math.max(at, 0));
  const written = words[at + 1];
  if (at < 1 || !receiver.every(isPlain) || written === undefined) {
    return new UnreadFile(key, path, "в файле нет строки определения");
  }
  const rest = words.slice(at + 1);
  const said = saidOf(rest);
  const body = rest.slice(said.body);
  const name = storedName(written, blockParams(body));
  const found = keyOf(receiver, name);
  if (found !== key) {
    return new UnreadFile(key, path, `в файле ${found}, ждали ${key}`);
  }
  // Назначение не сказано или не закрыто: хэш — слова как есть; запись в
  // базу откажет проверкой `define:`.
  const line =
    said.purpose === undefined || said.unclosed !== undefined
      ? words.join(" ")
      : canonicalLine({
          receiver,
          name,
          purpose: said.purpose,
          keys: said.keys,
          body,
        });
  return new MethodFile({ path, receiver, name, words, body, line });
}
