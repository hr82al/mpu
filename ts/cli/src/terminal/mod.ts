/**
 * Управляющий терминал процесса (`/dev/tty`): вопрос человеку и его
 * ответ, видимый или скрытый. Отдельный модуль, потому что терминал
 * нужен обоим — и монолитному `mpu` внутри сервера, и тонкому клиенту,
 * который показывает вопрос строки (`platform/line-prompt.md`).
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Полная запись: `writeSync` может записать буфер частично. */
function writeAllSync(
  stream: { writeSync(data: Uint8Array): number },
  text: string,
) {
  const bytes = encoder.encode(text);
  let written = 0;
  while (written < bytes.length) {
    written += stream.writeSync(bytes.subarray(written));
  }
}

/**
 * Открытый управляющий терминал: вопрос человеку и его ответ. У
 * команды его нет — есть порт `Prompt`; этим типом пользуются те, кто
 * терминал открывает: рантайм процесса и тонкий клиент.
 *
 * Имя устройства необязательно: в Deno нет `ttyname`, и тот, кто его не
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

/**
 * Строка, набранная вслепую: терминал переводится в raw-режим, эхо
 * гасит он сам. Режим возвращается в `finally` — иначе терминал
 * остался бы без эха у вызывающего shell'а, и это чинилось бы уже
 * командой `reset`.
 *
 * Разбор посимвольный, потому что в raw-режиме строк нет: перевод
 * строки заканчивает ввод, `DEL`/`BS` стирают символ, `Ctrl-C` и
 * `Ctrl-D` означают «ответа нет».
 */
async function readSecretFrom(file: Deno.FsFile): Promise<string | undefined> {
  // `cbreak` оставляет ISIG: Ctrl-C прерывает ввод сигналом, как в
  // любом другом приглашении. Без него единственным выходом из вопроса
  // о пароле был бы правильный ответ.
  file.setRaw(true, { cbreak: true });
  try {
    const bytes: number[] = [];
    const chunk = new Uint8Array(1);
    while (true) {
      const read = await file.read(chunk);
      if (read === null) break;
      const byte = chunk[0];
      if (byte === 0x0a || byte === 0x0d) break;
      // Ctrl-C и Ctrl-D: ответа не будет, и это не пустая строка.
      if (byte === 0x03 || byte === 0x04) return undefined;
      if (byte === 0x7f || byte === 0x08) {
        // Стирается символ, а не байт: у кириллицы и эмодзи их
        // несколько, и `pop` одного разорвал бы UTF-8 — пароль молча
        // отличался бы от набранного, а показать это некому.
        while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) {
          bytes.pop();
        }
        bytes.pop();
        continue;
      }
      bytes.push(byte);
    }
    return decoder.decode(Uint8Array.from(bytes));
  } finally {
    file.setRaw(false);
    // Перевод строки за пользователя: его собственный не отобразился.
    // Пишется в stderr, а не в сам терминал: запись в `/dev/tty`
    // требует `--allow-all` (см. `openControllingTerminal`).
    writeAllSync(Deno.stderr, "\n");
  }
}

/**
 * Управляющий терминал процесса: `/dev/tty`, открытый только на
 * чтение — запись в него требует `--allow-all` (замер ниже). Терминала
 * нет (пайп без tty, cron, вызов тула) — открыть не удаётся, и это не
 * ошибка, а ответ `undefined`: решает по нему команда
 * (`docs/specs/confirm.md`).
 *
 * Имя устройства не сообщается: `ttyname` в Deno нет, и выдумывать его
 * по номеру fd — значит печатать в диагностике догадку.
 */
export async function openControllingTerminal(): Promise<
  TerminalIo | undefined
> {
  let file: Deno.FsFile;
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
    file = await Deno.open("/dev/tty", { read: true });
  } catch {
    return undefined;
  }
  return {
    name: undefined,
    // Вопрос идёт в stderr: писать в сам терминал нельзя (см. выше), а
    // stderr в интерактивном сеансе — он же и есть. Запись синхронная
    // поверх того же полного writeAll, что и у потоков процесса.
    write: (text) => {
      writeAllSync(Deno.stderr, text);
      return Promise.resolve();
    },
    readLine: () => readLineFrom(file),
    readSecret: () => readSecretFrom(file),
    [Symbol.dispose]: () => file.close(),
  };
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
