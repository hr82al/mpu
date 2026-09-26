/**
 * Признаки экрана Claude Code (`task-orchestrator.md`, «Открытые
 * вопросы»): строки текущей версии, одна таблица на границе. Сменится
 * версия — правка здесь, больше нигде.
 */

/** Слова семейств моделей: по ним судится модель на экране. */
const MODEL_WORDS = /\b(opus|sonnet|haiku|fable)\b/gi;

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

  /** На экране модель профиля: последнее слово семейства — её. */
  shows(model: string): boolean {
    const shown = this.#shownModel();
    return shown !== "" && model.toLowerCase().includes(shown);
  }

  /**
   * Модель на экране расходится с моделью профиля. Судится по последнему
   * слову семейства; слова нет — не судится (не расходится).
   */
  differsFrom(model: string): boolean {
    const shown = this.#shownModel();
    return shown !== "" && !model.toLowerCase().includes(shown);
  }

  /** Последнее слово семейства на экране в нижнем регистре; нет — пусто. */
  #shownModel(): string {
    return [...this.#text.matchAll(MODEL_WORDS)].at(-1)?.[1].toLowerCase() ??
      "";
  }
}

/** Текущая команда панели, когда в окне Claude Code. */
export const CLAUDE_COMMAND = "claude";
