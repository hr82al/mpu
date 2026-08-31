/**
 * Копирование текста в буфер обмена (`platform/clipboard.md`).
 * Возможность вспомогательная: текст к этому моменту уже напечатан в
 * stdout, копирование — удобство поверх него. Поэтому наружу не
 * всплывает ни одна ошибка: ответ — только «удалось» или «нет».
 *
 * Попытка одна — внешняя утилита X11/Wayland. Управляющая
 * последовательность терминала (OSC 52) была первой и убрана порцией
 * 91: она писала в `/dev/tty`, а он открывается на запись только под
 * `--allow-all` (замер 2026-08-31, Deno 2.9.5; список путей не
 * помогает). Боевой бинарь такого права не получает, поэтому попытка
 * не удавалась ни разу с рождения — вместе с ней ушли право
 * `--allow-write=…,/dev/tty` и чтение `TMUX`.
 */

/** Предел ожидания внешней утилиты (спека). */
const UTILITY_TIMEOUT_MS = 2_000;

/** Утилиты по порядку попыток (спека). */
const UTILITIES: readonly (readonly [string, readonly string[]])[] = [
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
];

/** Что возможность делает с внешним миром; подменяется в тестах. */
export interface ClipboardPorts {
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
}

/** Удалось ли положить текст в буфер обмена. */
export async function copyToClipboard(
  text: string,
  ports: Partial<ClipboardPorts> = {},
): Promise<boolean> {
  const io: ClipboardPorts = { ...denoPorts(), ...ports };
  const bytes = new TextEncoder().encode(text);
  for (const [bin, args] of UTILITIES) {
    if (await io.runUtility(bin, args, bytes, UTILITY_TIMEOUT_MS)) return true;
  }
  return false;
}

/**
 * Настоящие подпроцессы. Экспортируется потому же, почему и
 * подстановка: у возможности две реализации одного порта, и обе —
 * часть её поверхности.
 */
export function denoPorts(): ClipboardPorts {
  return {
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
