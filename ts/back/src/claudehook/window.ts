/**
 * Окно tmux, откуда пришёл вопрос (`claude-hook-permission-request.md`,
 * «Payload → форма вопроса» [D.4]): `<сессия>:<номер> <имя окна>`. У
 * службы своей `TMUX` нет, поэтому сокет и панель — из окружения
 * клиента хука, принесённого строкой.
 */

/** Программа tmux: путём, как в праве `--allow-run` ядра [D.7]. */
export const TMUX = "/usr/bin/tmux";

/** Сколько ждать ответа tmux. */
export const WINDOW_MS = 1000;

/**
 * Запуск tmux с аргументами `args`: stdout при успехе; отказ, нет
 * программы, срок вышел — `undefined`.
 */
export type TmuxRun = (args: readonly string[]) => Promise<string | undefined>;

/** Настоящий tmux: срок — `WINDOW_MS`, по сроку процесс снимается. */
export const RUN_TMUX: TmuxRun = async (args) => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(TMUX, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(WINDOW_MS),
    }).output();
  } catch (err) {
    // Нет tmux или права его звать — подписи нет: окно лишь подписывает
    // вопрос и не меняет, куда он идёт.
    if (err instanceof Deno.errors.NotFound) return undefined;
    if (err instanceof Deno.errors.NotCapable) return undefined;
    throw err;
  }
  return output.success ? new TextDecoder().decode(output.stdout) : undefined;
};

/** Переменная окружения клиента; не принесена — `undefined`. */
export type CallerEnv = (name: string) => string | undefined;

/** Окна tmux. */
export class Windows {
  readonly #run: TmuxRun;

  constructor(run: TmuxRun) {
    this.#run = run;
  }

  /**
   * Место «окно» заголовка: подпись окна клиента или пусто — нет `TMUX`
   * или `TMUX_PANE`, tmux не ответил.
   */
  async captionOf(env: CallerEnv): Promise<readonly string[]> {
    const tmux = env("TMUX");
    const pane = env("TMUX_PANE");
    if (tmux === undefined || pane === undefined) return [];
    // Сокет — часть `TMUX` до первой запятой: дальше pid и номер сессии.
    const socket = tmux.split(",")[0];
    const said = await this.#run([
      "-S",
      socket,
      "display-message",
      "-p",
      "-t",
      pane,
      "#S:#I #W",
    ]);
    const caption = (said ?? "").trim();
    return caption === "" ? [] : [caption];
  }
}

/** Окон нет: подписи не бывает. */
export const NO_WINDOWS = new Windows(() => Promise.resolve(undefined));
