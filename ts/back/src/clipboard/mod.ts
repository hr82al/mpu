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

/** Предел ожидания внешней утилиты (спека). */
const UTILITY_TIMEOUT_MS = 2_000;

/** Байты управляющей последовательности. */
const ESC = 0x1b;
const BEL = 0x07;

/** Утилиты по порядку попыток (спека). */
const UTILITIES: readonly (readonly [string, readonly string[]])[] = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
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
  const io: ClipboardPorts = { ...denoPorts(), ...ports };
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
export function denoPorts(): ClipboardPorts {
  return {
    writeTerminal: async (bytes) => {
      // Не терминал — писать некуда: последовательность легла бы
      // мусором в файл или в перехваченный stderr, а буфер остался бы
      // пустым. Утилита рядом в этом случае сработает.
      if (!Deno.stderr.isTerminal()) return false;
      try {
        await writeAll(Deno.stderr, bytes);
        return true;
      } catch {
        // Отказ записи — не ошибка вызова, а повод перейти ко второй
        // попытке (спека: наружу ошибка не идёт).
        return false;
      }
    },
    runUtility: async (bin, args, stdin, timeoutMs) => {
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(bin, {
          args: [...args],
          stdin: "piped",
          // Потоки подавляются не для красоты: `wl-copy` и `xclip`
          // уходят в фон, удерживая владение выделением, а вместе с ним
          // — унаследованный stdout; читатель вывода команды не увидел
          // бы конца потока до их смерти (спека).
          stdout: "null",
          stderr: "null",
        }).spawn();
      } catch {
        // Утилиты нет в PATH — следующая по списку.
        return false;
      }
      return await feedAndWait(child, stdin, timeoutMs);
    },
    env: (name) => Deno.env.get(name),
  };
}

/** Подаёт текст утилите и ждёт её не дольше предела. */
async function feedAndWait(
  child: Deno.ChildProcess,
  stdin: Uint8Array,
  timeoutMs: number,
): Promise<boolean> {
  const timer = setTimeout(() => {
    // Зависшая утилита не держит команду: её убивают, попытка
    // считается неуспешной (спека, «Инварианты»).
    try {
      child.kill();
    } catch {
      // Уже завершилась — убивать нечего.
    }
  }, timeoutMs);
  try {
    const writer = child.stdin.getWriter();
    // Отказ записи исходом попытки не считается: утилита, закрывшая
    // stdin раньше времени, всё равно отвечает своим кодом выхода, а
    // спека перечисляет причинами неуспеха только его, отказ запуска и
    // истёкшее ожидание.
    await writer.write(stdin).catch(() => {});
    await writer.close().catch(() => {});
    return (await child.status).success;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Полная запись: `write` может взять не весь буфер разом. */
async function writeAll(
  sink: { write: (bytes: Uint8Array) => Promise<number> },
  bytes: Uint8Array,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await sink.write(bytes.subarray(written));
  }
}
