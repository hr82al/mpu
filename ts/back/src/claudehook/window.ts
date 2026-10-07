/**
 * Окно tmux, откуда пришёл вопрос (`claude-hook-permission-request.md`,
 * «Payload → форма вопроса» [D.4]): `<сессия>:<номер> <имя окна>`. У
 * службы своей `TMUX` нет, поэтому сокет и панель — из окружения
 * клиента хука, принесённого строкой.
 */

import { hasErrorCode, isPermissionRefusal } from "../oserror/mod.ts";
import { type ProgramOutput, runProgram } from "../subprocess/mod.ts";

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
  let output: ProgramOutput;
  try {
    output = await runProgram(TMUX, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(WINDOW_MS),
    });
  } catch (err) {
    // Нет tmux или права его звать — подписи нет: окно лишь подписывает
    // вопрос и не меняет, куда он идёт.
    if (hasErrorCode(err, "ENOENT")) return undefined;
    if (isPermissionRefusal(err)) return undefined;
    throw err;
  }
  return output.success ? new TextDecoder().decode(output.stdout) : undefined;
};

/** Переменная окружения клиента; не принесена — `undefined`. */
export type CallerEnv = (name: string) => string | undefined;

/** Что сделать с окном клиента: оно есть или его нет. */
export interface PaneChoice<T> {
  window(pane: Pane): T;
  none(): T;
}

/** Окно, в котором уже не Claude Code: в него ничего не уходит. */
export interface PaneGuard<T> {
  /** Окно закрыто или tmux не ответил. */
  gone(): T;
  /** В окне идёт не Claude Code (оболочка после его выхода). */
  left(): T;
}

/** Чтение снятого экрана. */
export interface ScreenReader<T> extends PaneGuard<T> {
  /** Экран — вывод `capture-pane -p`. */
  seen(screen: string): T;
}

/** Исход нажатия или вписывания. */
export interface KeysReader<T> extends PaneGuard<T> {
  /** Клавиши ушли в окно. */
  sent(): T;
}

/** Окно tmux клиента хука: сокет и панель — с его окружения. */
export interface Pane {
  offer<T>(choice: PaneChoice<T>): T;
  /** Место «окно» заголовка: подпись окна или пусто — tmux не ответил. */
  caption(): Promise<readonly string[]>;
  /** Снимает экран, пока в окне Claude Code. */
  look<T>(reader: ScreenReader<T>): Promise<T>;
  /**
   * Нажимает клавишу (`1`…`9`, `Enter`, `Escape`, `Up`, `Down`), пока в
   * окне Claude Code.
   */
  press<T>(key: string, reader: KeysReader<T>): Promise<T>;
  /** Вписывает текст как есть и нажимает `Enter`, пока в окне Claude Code. */
  type<T>(text: string, reader: KeysReader<T>): Promise<T>;
}

/** Окна клиента нет (нет `TMUX` или `TMUX_PANE`). */
export const NO_PANE: Pane = {
  offer: (choice) => choice.none(),
  caption: () => Promise.resolve([]),
  look: (reader) => Promise.resolve(reader.gone()),
  press: (_key, reader) => Promise.resolve(reader.gone()),
  type: (_text, reader) => Promise.resolve(reader.gone()),
};

/**
 * Что идёт в окне с Claude Code (`#{pane_current_command}`; снято
 * 2026-10-06: оболочка — `bash`).
 */
const CLAUDE_COMMAND = "claude";

/** Окно tmux по сокету и панели. */
class TmuxPane implements Pane {
  readonly #run: TmuxRun;
  readonly #socket: string;
  readonly #pane: string;

  constructor(run: TmuxRun, socket: string, pane: string) {
    this.#run = run;
    this.#socket = socket;
    this.#pane = pane;
  }

  offer<T>(choice: PaneChoice<T>): T {
    return choice.window(this);
  }

  async caption(): Promise<readonly string[]> {
    const said = await this.#tmux([
      "display-message",
      "-p",
      "-t",
      this.#pane,
      "#S:#I #W",
    ]);
    const caption = (said ?? "").trim();
    return caption === "" ? [] : [caption];
  }

  look<T>(reader: ScreenReader<T>): Promise<T> {
    return this.#guarded(reader, async () => {
      const screen = await this.#tmux(["capture-pane", "-p", "-t", this.#pane]);
      return screen === undefined ? reader.gone() : reader.seen(screen);
    });
  }

  press<T>(key: string, reader: KeysReader<T>): Promise<T> {
    return this.#guarded(
      reader,
      async () => await this.#key(key) ? reader.sent() : reader.gone(),
    );
  }

  type<T>(text: string, reader: KeysReader<T>): Promise<T> {
    return this.#guarded(reader, async () => {
      // `--`: текст владельца, начатый с `-`, — текст, а не ключи tmux.
      const typed = await this.#tmux([
        "send-keys",
        "-t",
        this.#pane,
        "-l",
        "--",
        text,
      ]);
      return typed !== undefined && await this.#key("Enter")
        ? reader.sent()
        : reader.gone();
    });
  }

  /**
   * Работа над окном — только пока в нём Claude Code: после его выхода
   * последний кадр остаётся на экране, и по экрану смену не отличить, а
   * клавиши ушли бы в оболочку командой.
   */
  async #guarded<T>(guard: PaneGuard<T>, work: () => Promise<T>): Promise<T> {
    const command = await this.#tmux([
      "display-message",
      "-p",
      "-t",
      this.#pane,
      "#{pane_current_command}",
    ]);
    if (command === undefined) return guard.gone();
    if (command.trim() !== CLAUDE_COMMAND) return guard.left();
    return await work();
  }

  /** Одна клавиша без охраны: её делают `press` и `type`. */
  async #key(key: string): Promise<boolean> {
    return await this.#tmux(["send-keys", "-t", this.#pane, key]) !==
      undefined;
  }

  #tmux(args: readonly string[]): Promise<string | undefined> {
    return this.#run(["-S", this.#socket, ...args]);
  }
}

/** Окна tmux. */
export class Windows {
  readonly #run: TmuxRun;

  constructor(run: TmuxRun) {
    this.#run = run;
  }

  /** Окно клиента; нет `TMUX` или `TMUX_PANE` — `NO_PANE`. */
  paneOf(env: CallerEnv): Pane {
    const tmux = env("TMUX");
    const pane = env("TMUX_PANE");
    if (tmux === undefined || pane === undefined) return NO_PANE;
    // Сокет — часть `TMUX` до первой запятой: дальше pid и номер сессии.
    return new TmuxPane(this.#run, tmux.split(",")[0], pane);
  }

  /**
   * Место «окно» заголовка: подпись окна клиента или пусто — нет `TMUX`
   * или `TMUX_PANE`, tmux не ответил.
   */
  captionOf(env: CallerEnv): Promise<readonly string[]> {
    return this.paneOf(env).caption();
  }
}

/** Окон нет: подписи не бывает. */
export const NO_WINDOWS = new Windows(() => Promise.resolve(undefined));
