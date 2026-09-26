/**
 * Порт docker для `mpu mp-init` и его настоящая реализация.
 *
 * Вызовов два вида, и различаются они не тем, что запускается, а тем,
 * кому нужен вывод: пробе (inspect, `config --services`, `wait`, `logs`,
 * счёт миграций) вывод нужен нам — он разбирается; мутации (create,
 * build, up, stop) — оператору, и docker пишет его в терминал сам.
 */

/** Итог пробы: код и собранные потоки. */
export interface ProcessOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Запуск docker-процессов команды. */
export interface Docker {
  /**
   * Читающий вызов с захватом вывода. `signal` прерывает ожидание —
   * процесс снимается, исход всё равно приходит значением.
   */
  probe(
    argv: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProcessOutcome>;
  /** Мутация: вывод идёт в терминал как есть, наружу — только код. */
  run(argv: readonly string[], cwd: string): Promise<number>;
}

/** Часы: единственное, что нужно команде от времени, — дождаться срока. */
export interface Clock {
  /** Разрешается по истечении `ms` или раньше — по `signal`. */
  delay(ms: number, signal: AbortSignal): Promise<void>;
}

/** Настоящие часы. */
export const systemClock: Clock = {
  delay: (ms, signal) =>
    new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(id);
        resolve();
      }, { once: true });
    }),
};

/**
 * Настоящий docker. stdout мутаций — в терминал, как и было: docker
 * пишет туда ход сборки и подъёма.
 */
export const systemDocker: Docker = {
  async probe(argv, cwd, signal) {
    const [bin, ...rest] = argv;
    const output = await new Deno.Command(bin, {
      args: rest,
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  },
  async run(argv, cwd) {
    const [bin, ...rest] = argv;
    const output = await new Deno.Command(bin, {
      args: rest,
      cwd,
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    return output.code;
  },
};
