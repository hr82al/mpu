/**
 * Порт входа MTProto (`telegram-login.md`): что живой вход спрашивает у
 * человека и что отдаёт. Сценарий входа — ветки, env-файл, тексты хода —
 * у потребителя; здесь только форма обмена, поэтому сценарий проверяется
 * двойником, без сети.
 */

/** Что вход спрашивает у человека. */
export interface LoginPrompts {
  /** Вопрос с видимым ответом; ответа нет — `undefined`. */
  readonly ask: (question: string) => Promise<string | undefined>;
  /** Вопрос со скрытым ответом: пароль второго фактора. */
  readonly askSecret: (question: string) => Promise<string | undefined>;
  /**
   * Строка хода входа от клиента (код отправлен, код не подошёл) — туда
   * же, куда прочие строки хода сценария, а не в stdout («stdout входа»).
   */
  readonly progress: (line: string) => void;
}

/** Живой вход в Telegram. */
export interface LoginClient {
  /**
   * Проводит вход и возвращает строку сессии. Код и пароль клиент
   * спрашивает сам через переданные функции: их порядок и число
   * попыток задаёт протокол, а не мы.
   */
  readonly signIn: (phone: string, prompts: LoginPrompts) => Promise<string>;
  readonly close: () => Promise<void>;
}

/** Ключи приложения Telegram. */
export interface AppKeys {
  readonly apiId: string;
  readonly apiHash: string;
}
