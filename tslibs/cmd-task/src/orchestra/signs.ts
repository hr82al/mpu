/**
 * Признаки экрана Claude Code (`task-orchestrator.md`, «Открытые
 * вопросы»): строки текущей версии, одна таблица на границе. Сменится
 * версия — правка здесь, больше нигде.
 */

/**
 * Вторая строка логотипа: модель и план (снято на Claude Code 2.1.283:
 * `▝▜██████▀  Sonnet 5 · Claude Max`). Первое слово имени — семейство.
 * Признак модели — только она: имя модели в тексте роли не в счёт.
 */
const BANNER_MODEL = /^\s*▝▜█+▀\s+(\S+)[^\n]* · /m;

/** Экран окна роли, как его отдал tmux. */
export class Screen {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  /** Строка ввода с первым сообщением роли (признак удачного запуска). */
  showsPrompt(message: string): boolean {
    return this.#text.includes(`❯ ${message}`);
  }

  /** Режим `auto` включён. */
  showsAutoMode(): boolean {
    return this.#text.includes("auto mode on");
  }

  /** Роль работает: её можно прервать. */
  isWorking(): boolean {
    return this.#text.includes("esc to interrupt");
  }

  /** Диалог доверия каталогу: снять его может только человек. */
  asksTrust(): boolean {
    return this.#text.includes("Do you trust the files in this folder?");
  }

  /** Баннер называет модель профиля. */
  shows(model: string): boolean {
    const shown = this.#shownModel();
    return shown !== "" && model.toLowerCase().includes(shown);
  }

  /**
   * Баннер называет модель не из профиля; баннера нет — не судится (не
   * расходится).
   */
  differsFrom(model: string): boolean {
    const shown = this.#shownModel();
    return shown !== "" && !model.toLowerCase().includes(shown);
  }

  /** Семейство модели с баннера в нижнем регистре; баннера нет — пусто. */
  #shownModel(): string {
    return BANNER_MODEL.exec(this.#text)?.[1].toLowerCase() ?? "";
  }
}

/** Текущая команда панели, когда в окне Claude Code. */
export const CLAUDE_COMMAND = "claude";
