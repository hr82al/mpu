/**
 * Управляющий терминал процесса (`/dev/tty`): вопрос человеку и его
 * ответ, видимый или скрытый. Отдельный модуль, потому что терминал
 * нужен обоим — и монолитному `mpu` внутри сервера, и тонкому клиенту,
 * который показывает вопрос строки (`platform/line-prompt.md`).
 */

import { closeSync, openSync, read, writeSync } from "node:fs";
import process from "node:process";
import { ReadStream } from "node:tty";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const STDERR = 2;

/** Полная запись: `writeSync` может записать буфер частично. */
function writeAllSync(fd: number, text: string) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes.subarray(written));
  }
}

/**
 * Открытый управляющий терминал: вопрос человеку и его ответ. У
 * команды его нет — есть порт `Prompt`; этим типом пользуются те, кто
 * терминал открывает: рантайм процесса и тонкий клиент.
 *
 * Имя устройства необязательно: в `node:*` нет `ttyname`, и тот, кто его не
 * знает, честно отдаёт `undefined` — диагностика назовёт это вслух, а
 * не укоротит вывод молча (`docs/specs/confirm.md`).
 */
export interface TerminalIo extends Disposable {
  readonly name: string | undefined;
  /** Пишет текст в терминал как есть, без добавленного перевода. */
  readonly write: (text: string) => Promise<void>;
  /** Одна строка ответа без перевода; конец ввода — `undefined`. */
  readonly readLine: () => Promise<string | undefined>;
  /**
   * То же, но набранное не показывается на экране: пароль второго
   * фактора Telegram (`docs/specs/telegram-login.md`, инвариант 1).
   * Отдельный метод, а не флаг у `readLine`: у скрытого чтения другой
   * режим терминала, и «видимо ли набранное» должно быть видно на
   * месте вызова, а не спрятано в аргументе.
   */
  readonly readSecret: () => Promise<string | undefined>;
}

/** Исход скрытого ввода: набранное или «ответа нет», и было ли прерывание. */
interface Typed {
  readonly text: string | undefined;
  readonly interrupted: boolean;
}

/**
 * Байт скрытого ввода: исход, если строка кончилась, иначе байт ложится
 * в набранное. Перевод строки заканчивает ввод, `DEL`/`BS` стирают
 * символ, `Ctrl-C` и `Ctrl-D` означают «ответа нет».
 */
function keyed(bytes: number[], byte: number): Typed | undefined {
  if (byte === 0x0a || byte === 0x0d) {
    return { text: decoder.decode(Uint8Array.from(bytes)), interrupted: false };
  }
  // Ctrl-C и Ctrl-D: ответа не будет, и это не пустая строка.
  if (byte === 0x03 || byte === 0x04) {
    return { text: undefined, interrupted: byte === 0x03 };
  }
  if (byte === 0x7f || byte === 0x08) {
    // Стирается символ, а не байт: у кириллицы и эмодзи их
    // несколько, и `pop` одного разорвал бы UTF-8 — пароль молча
    // отличался бы от набранного, а показать это некому.
    while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) {
      bytes.pop();
    }
    bytes.pop();
    return undefined;
  }
  bytes.push(byte);
  return undefined;
}

/**
 * Набранное в потоке терминала до исхода. Поток встаёт на паузу сразу
 * на исходе: набранное после Enter достаётся следующему читателю.
 */
function typedFrom(stream: ReadStream): Promise<Typed> {
  const bytes: number[] = [];
  return new Promise((resolve, reject) => {
    const settled = () => {
      stream.pause();
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const done = (typed: Typed) => {
      settled();
      resolve(typed);
    };
    // Отказ чтения терминала (обрыв, закрытое окно) — отказ вопроса:
    // режим терминала вернёт `finally` вызывающего.
    const onError = (err: Error) => {
      settled();
      reject(err);
    };
    const onEnd = () =>
      done({
        text: decoder.decode(Uint8Array.from(bytes)),
        interrupted: false,
      });
    const onData = (chunk: Uint8Array) => {
      for (const byte of chunk) {
        const typed = keyed(bytes, byte);
        if (typed !== undefined) return done(typed);
      }
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

/**
 * Строка, набранная вслепую: терминал переводится в raw-режим, эхо
 * гасит он сам. Режим возвращается в `finally` — иначе терминал
 * остался бы без эха у вызывающего shell'а, и это чинилось бы уже
 * командой `reset`.
 *
 * Читается потоком на своём дескрипторе `/dev/tty`: `tty.ReadStream`
 * под Node переводит дескриптор в неблокирующий режим, и побайтное
 * чтение строки на нём отказало бы с `EAGAIN`. Режим — свойство
 * устройства, а не дескриптора, поэтому он действует и так.
 */
async function readSecret(): Promise<string | undefined> {
  const stream = new ReadStream(openSync("/dev/tty", "r"));
  let typed: Typed;
  try {
    stream.setRawMode(true);
    typed = await typedFrom(stream);
  } finally {
    // Режим — до `destroy`: после него у потока Deno нет дескриптора.
    stream.setRawMode(false);
    stream.destroy();
    // Перевод строки за пользователя: его собственный не отобразился.
    // Пишется в stderr, а не в сам терминал: запись в `/dev/tty`
    // требует `--allow-all` (см. `openControllingTerminal`).
    writeAllSync(STDERR, "\n");
  }
  // Raw-режим гасит ISIG, и Ctrl-C пришёл байтом. Прежде (Deno,
  // `cbreak`) он был сигналом: прерывание возвращается тем же сигналом —
  // иначе единственным выходом из вопроса о пароле был бы ответ.
  if (typed.interrupted) process.kill(process.pid, "SIGINT");
  return typed.text;
}

/** Читает в `chunk` до одного байта: число прочитанных, конец ввода — `null`. */
function readInto(fd: number, chunk: Uint8Array): Promise<number | null> {
  return new Promise((resolve, reject) =>
    read(fd, chunk, 0, 1, null, (err, count) => {
      if (err !== null) return reject(err);
      resolve(count === 0 ? null : count);
    })
  );
}

/**
 * Управляющий терминал процесса: `/dev/tty`, открытый только на
 * чтение — запись в него требует `--allow-all` (замер ниже). Терминала
 * нет (пайп без tty, cron, вызов тула) — открыть не удаётся, и это не
 * ошибка, а ответ `undefined`: решает по нему команда
 * (`docs/specs/confirm.md`).
 *
 * Имя устройства не сообщается: `ttyname` в `node:*` нет, и выдумывать его
 * по номеру fd — значит печатать в диагностике догадку.
 */
export function openControllingTerminal(): Promise<
  TerminalIo | undefined
> {
  let fd: number;
  try {
    // Только на чтение — и это не экономия права, а единственная
    // работающая форма. Замер 2026-08-31 на Deno 2.9.5 под
    // псевдотерминалом: `{read:true}` открывается при обычных правах,
    // а `{write:true}` и `{read:true,write:true}` требуют
    // `--allow-all` («Requires all access to "/dev/tty"») — при любом
    // списке путей, включая `--allow-read --allow-write` без
    // ограничений. Собранный бинарь `--allow-all` не несёт и нести не
    // должен, поэтому вопрос печатается в stderr: там его видно и в
    // конвейере, где stdout занят данными.
    fd = openSync("/dev/tty", "r");
  } catch {
    return Promise.resolve(undefined);
  }
  const file = { read: (chunk: Uint8Array) => readInto(fd, chunk) };
  return Promise.resolve({
    name: undefined,
    // Вопрос идёт в stderr: писать в сам терминал нельзя (см. выше), а
    // stderr в интерактивном сеансе — он же и есть. Запись синхронная
    // поверх того же полного writeAll, что и у потоков процесса.
    write: (text) => {
      writeAllSync(STDERR, text);
      return Promise.resolve();
    },
    readLine: () => readLineFrom(file),
    readSecret,
    [Symbol.dispose]: () => closeSync(fd),
  });
}

/**
 * Одна строка ответа. Читается побайтно: терминал отдаёт ввод по
 * нажатию Enter, а забрать из него лишнее нельзя — следующий читатель
 * этого же устройства недосчитался бы своего.
 */
async function readLineFrom(
  file: { read(p: Uint8Array): Promise<number | null> },
): Promise<string | undefined> {
  const bytes: number[] = [];
  const chunk = new Uint8Array(1);
  while (true) {
    const read = await file.read(chunk);
    if (read === null) break;
    if (read === 0) continue;
    if (chunk[0] === 0x0a) return decoder.decode(new Uint8Array(bytes));
    bytes.push(chunk[0]);
  }
  return bytes.length === 0 ? undefined : decoder.decode(new Uint8Array(bytes));
}
