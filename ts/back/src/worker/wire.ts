/**
 * Провод между ядром и исполнителем: строки NDJSON поверх пары потоков
 * байт. Один и тот же у процесса (stdin/stdout исполнителя) и у
 * исполнителя в памяти — кодек кадров у обоих вариантов общий.
 */

/** Один конец провода. */
export interface Wire {
  /** Входящие строки без перевода строки; конец — провод закрыт той стороной. */
  lines(): AsyncIterable<string>;
  /**
   * Послать строку. Обещание разрешается, когда байты приняты потоком:
   * медленная сторона притормаживает посылающую, а не копит в памяти.
   */
  send(text: string): Promise<void>;
  /** Посылать больше нечего: та сторона увидит конец. */
  close(): Promise<void>;
}

async function* linesOf(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  let rest = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    yield* parts;
  }
  if (rest !== "") yield rest;
}

/**
 * Запись на провод, чья та сторона уже ушла (исполнитель умер, ядро
 * закрыло канал), — не сбой посылающего: о её уходе скажет конец
 * входящих строк, и решает по нему тот, кто их читает.
 */
async function gone(written: Promise<void>): Promise<void> {
  try {
    await written;
  } catch (err) {
    if (err instanceof TypeError || err instanceof Deno.errors.BrokenPipe) {
      return;
    }
    throw err;
  }
}

/**
 * Провод из читаемого и записываемого потоков.
 *
 * @param input откуда приходят строки
 * @param output куда уходят
 */
export function streamWire(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
): Wire {
  const writer = output.getWriter();
  const encoder = new TextEncoder();
  return {
    lines: () => linesOf(input),
    // Порядок строк держит сам писатель: запись за записью в очереди
    // потока, сколько бы посылающих ни было.
    send: (text) => gone(writer.write(encoder.encode(text))),
    close: () => gone(writer.close()),
  };
}

/** Два конца провода в памяти: что послал один, читает другой. */
export function memoryWires(): { readonly host: Wire; readonly worker: Wire } {
  const down = new TransformStream<Uint8Array, Uint8Array>();
  const up = new TransformStream<Uint8Array, Uint8Array>();
  return {
    host: streamWire(up.readable, down.writable),
    worker: streamWire(down.readable, up.writable),
  };
}
