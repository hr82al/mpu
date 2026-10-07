/**
 * Копирование текста в буфер обмена (`platform/clipboard.md`).
 * Возможность вспомогательная: текст к этому моменту уже напечатан в
 * stdout, копирование — удобство поверх него. Поэтому наружу не
 * всплывает ни одна ошибка: ответ — только «удалось» или «нет».
 *
 * Две попытки строго по порядку: управляющая последовательность
 * терминала (работает и через ssh — буфер берёт локальный эмулятор) и
 * внешняя утилита X11/Wayland.
 *
 * Последовательность уходит в **stderr**, а не в `/dev/tty`: туда
 * писать нельзя ни при каком списке путей — только под `--allow-all`
 * (замер 2026-08-31, Deno 2.9.5). Из-за этого попытка не удавалась ни
 * разу с рождения и была убрана порцией 91; порция 92 вернула её в
 * работающей форме — той же, какой печатается вопрос терминала
 * (`src/runtime/mod.ts`). Права она не требует вовсе.
 *
 * Проверено при этом только то, что байты ушли в stderr в правильном
 * виде: **сработает ли последовательность в настоящем эмуляторе,
 * отсюда не видно**, и замер этого — за владельцем терминала.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import tty from "node:tty";

/** Дескриптор stderr процесса. */
const STDERR = 2;

/** Предел ожидания внешней утилиты (спека). */
const UTILITY_TIMEOUT_MS = 2_000;

/** Байты управляющей последовательности. */
const ESC = 0x1b;
const BEL = 0x07;

/**
 * Программы копирования — **абсолютными путями**: клиент живёт и без
 * `PATH` в окружении (`cli-client.md`, «Права клиента и `PATH`»; smoke
 * «клиент стартует без PATH»). Цена названа честно: на машине, где
 * программа лежит не в `/usr/bin`, копирование не удастся — текст уйдёт
 * в stderr, тому же получателю, что и у клиента в конвейере.
 */
export const COPY_UTILITIES: readonly string[] = [
  "/usr/bin/wl-copy",
  "/usr/bin/xclip",
  "/usr/bin/xsel",
];

/** Утилиты по порядку попыток (спека): путь и его аргументы. */
const UTILITIES: readonly (readonly [string, readonly string[]])[] = [
  [COPY_UTILITIES[0], []],
  [COPY_UTILITIES[1], ["-selection", "clipboard"]],
  [COPY_UTILITIES[2], ["--clipboard", "--input"]],
];

/** Что возможность делает с внешним миром; подменяется в тестах. */
export interface ClipboardPorts {
  /**
   * Пишет байты в терминал (stderr). `false` — писать некуда: stderr
   * не терминал (пайп, файл, cron) либо запись отказала. Тогда идёт
   * вторая попытка — иначе в конвейере буфер остался бы пустым, хотя
   * утилита рядом сработала бы.
   */
  readonly writeTerminal: (bytes: Uint8Array) => Promise<boolean>;
  /**
   * Запускает утилиту, подавая текст на stdin. `false` — её нет в PATH,
   * она отказала или не уложилась в предел.
   */
  readonly runUtility: (
    bin: string,
    args: readonly string[],
    stdin: Uint8Array,
    timeoutMs: number,
  ) => Promise<boolean>;
  /** Переменные окружения процесса: `TMUX` — признак мультиплексора. */
  readonly env: (name: string) => string | undefined;
}

/** Удалось ли положить текст в буфер обмена. */
export async function copyToClipboard(
  text: string,
  ports: Partial<ClipboardPorts> = {},
): Promise<boolean> {
  const io: ClipboardPorts = { ...processPorts(), ...ports };
  if (await io.writeTerminal(osc52(text, io.env("TMUX")))) return true;
  const bytes = new TextEncoder().encode(text);
  for (const [bin, args] of UTILITIES) {
    if (await io.runUtility(bin, args, bytes, UTILITY_TIMEOUT_MS)) return true;
  }
  return false;
}

/**
 * OSC 52: `ESC ] 5 2 ; c ; <base64> BEL`. Под tmux последовательность
 * заворачивается в passthrough, иначе её съедает мультиплексор.
 */
export function osc52(text: string, tmux: string | undefined): Uint8Array {
  const encoder = new TextEncoder();
  const payload = encoder.encode(text);
  const base64 = btoa(String.fromCharCode(...payload));
  const sequence = [ESC, ...encoder.encode(`]52;c;${base64}`), BEL];
  if (tmux === undefined || tmux === "") return Uint8Array.from(sequence);
  return Uint8Array.from([
    ESC,
    ...encoder.encode("Ptmux;"),
    ESC,
    ...sequence,
    ESC,
    ...encoder.encode("\\"),
  ]);
}

/**
 * Настоящие терминал и подпроцессы. Экспортируется потому же, почему и
 * подстановка: у возможности две реализации одного порта, и обе —
 * часть её поверхности.
 */
export function processPorts(): ClipboardPorts {
  return {
    writeTerminal: (bytes) => {
      // Не терминал — писать некуда: последовательность легла бы
      // мусором в файл или в перехваченный stderr, а буфер остался бы
      // пустым. Утилита рядом в этом случае сработает. Запись и признак
      // — через объекты модулей: их подменяет тест адресата байтов.
      if (!tty.isatty(STDERR)) return Promise.resolve(false);
      try {
        writeAll(STDERR, bytes);
        return Promise.resolve(true);
      } catch {
        // Отказ записи — не ошибка вызова, а повод перейти ко второй
        // попытке (спека: наружу ошибка не идёт).
        return Promise.resolve(false);
      }
    },
    runUtility: (bin, args, stdin, timeoutMs) => {
      // Потоки подавляются не для красоты: `wl-copy` и `xclip`
      // уходят в фон, удерживая владение выделением, а вместе с ним
      // — унаследованный stdout; читатель вывода команды не увидел
      // бы конца потока до их смерти (спека).
      const child = spawn(bin, [...args], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      return feedAndWait(child, stdin, timeoutMs);
    },
    env: (name) => process.env[name],
  };
}

/**
 * Подаёт текст утилите и ждёт её не дольше предела. Утилиты нет в PATH
 * или она не запустилась — `false` (событие `error` до выхода).
 */
function feedAndWait(
  child: ChildProcess,
  stdin: Uint8Array,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Зависшая утилита не держит команду: её убивают, попытка
      // считается неуспешной (спека, «Инварианты»).
      child.kill();
    }, timeoutMs);
    const settle = (success: boolean) => {
      clearTimeout(timer);
      resolve(success);
    };
    child.once("error", () => settle(false));
    child.once("close", (code) => settle(code === 0));
    // Отказ записи исходом попытки не считается: утилита, закрывшая
    // stdin раньше времени, всё равно отвечает своим кодом выхода, а
    // спека перечисляет причинами неуспеха только его, отказ запуска и
    // истёкшее ожидание.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

/** Полная запись в дескриптор: `writeSync` может взять не весь буфер. */
function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.length) {
    written += fs.writeSync(fd, bytes.subarray(written));
  }
}
