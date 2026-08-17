/**
 * Копирование текста в буфер обмена (`platform/clipboard.md`).
 * Возможность вспомогательная: текст к этому моменту уже напечатан в
 * stdout, копирование — удобство поверх него. Поэтому наружу не
 * всплывает ни одна ошибка: ответ — только «удалось» или «нет».
 *
 * Две попытки строго по порядку: управляющая последовательность
 * терминала (работает и через ssh, буфер берёт локальный эмулятор) и
 * внешняя утилита X11/Wayland.
 */

/** Предел ожидания внешней утилиты (спека). */
const UTILITY_TIMEOUT_MS = 2_000;

/** Утилиты по порядку попыток (спека). */
const UTILITIES: readonly (readonly [string, readonly string[]])[] = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
];

/** Байты управляющей последовательности. */
const ESC = 0x1b;
const BEL = 0x07;

/** Что возможность делает с внешним миром; подменяется в тестах. */
export interface ClipboardPorts {
  /**
   * Пишет байты в `/dev/tty`. Открыть не удалось — `false`, и это
   * штатный ответ: вывод перенаправлен либо сессии без терминала.
   */
  readonly writeTty: (bytes: Uint8Array) => Promise<boolean>;
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
  /** Переменные окружения процесса: `TMUX` — признак терминала. */
  readonly env: (name: string) => string | undefined;
}

/** Удалось ли положить текст в буфер хоть одним способом. */
export async function copyToClipboard(
  text: string,
  ports: Partial<ClipboardPorts> = {},
): Promise<boolean> {
  const io: ClipboardPorts = { ...denoPorts(), ...ports };
  if (await io.writeTty(osc52(text, io.env("TMUX")))) return true;
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
  const sequence = [
    ESC,
    ...encoder.encode(`]52;c;${base64}`),
    BEL,
  ];
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

/** Настоящие /dev/tty и подпроцессы. */
function denoPorts(): ClipboardPorts {
  return {
    writeTty: async (bytes) => {
      let file: Deno.FsFile;
      try {
        file = await Deno.open("/dev/tty", { write: true });
      } catch {
        // Терминала нет либо он недоступен — это не ошибка вызова, а
        // повод перейти ко второй попытке (спека).
        return false;
      }
      try {
        await writeAll(file, bytes);
        return true;
      } catch {
        return false;
      } finally {
        file.close();
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
    try {
      await writer.write(stdin);
    } finally {
      await writer.close().catch(() => {});
    }
    return (await child.status).success;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await file.write(bytes.subarray(written));
  }
}
