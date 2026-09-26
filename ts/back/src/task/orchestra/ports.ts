/**
 * Порты оркестратора (`task-orchestrator.md`, «Порты и права»): окна
 * tmux, часы, уведомления и файлы первых сообщений. Настоящие — в
 * `tmux.ts` и `system.ts`, в тестах — поддельные.
 */

/** Окно tmux: `<сессия>:<окно>`. */
export interface Place {
  readonly session: string;
  readonly window: string;
}

/** Окна tmux. */
export interface Windows {
  hasSession(session: string): Promise<boolean>;
  /** Новая сессия с одним окном `place.window` в каталоге `dir`. */
  newSession(place: Place, dir: string): Promise<void>;
  /** Новое окно в существующей сессии, каталог `dir`. */
  newWindow(place: Place, dir: string): Promise<void>;
  /** Текущая команда панели; окна нет — `undefined` (граница порта). */
  command(place: Place): Promise<string | undefined>;
  /** Видимый текст панели. */
  screen(place: Place): Promise<string>;
  /** Набрать текст буквально, без Enter. */
  type(place: Place, text: string): Promise<void>;
  enter(place: Place): Promise<void>;
  close(place: Place): Promise<void>;
}

/** Часы: время и пауза. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Лог службы и уведомления. */
export interface Notices {
  /** Строка лога службы и, если можно, `notify-send`. */
  notify(text: string): Promise<void>;
  /** Только строка лога: сбой шага — не событие для человека. */
  log(text: string): Promise<void>;
}

/** Файлы первых сообщений. */
export interface Letters {
  /** Записывает файл, создавая каталоги. */
  write(path: string, text: string): Promise<void>;
}

/** Всё, чем оркестратор действует снаружи. */
export interface Hands {
  readonly windows: Windows;
  readonly clock: Clock;
  readonly notices: Notices;
  readonly letters: Letters;
  /** Каталог файлов первых сообщений: `$XDG_RUNTIME_DIR/mpu-task`. */
  readonly letterDir: string;
}
