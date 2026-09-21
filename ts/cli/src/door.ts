/**
 * Дверь строки: путь на сервере, токен и отвечающий
 * (`cli-client.md`, «Канал и токен»). Три строки таблицы — три двери,
 * выбранные один раз: дальше клиент о токенах и терминалах не спрашивает.
 */

import type { ContextFields, FirstFrame } from "../../back/src/frames/mod.ts";
import { type Asker, NOBODY } from "./asker.ts";

/** Путь, токен и отвечающий строки. */
export class Door {
  readonly #path: string;
  readonly #token: string;
  readonly #asker: Asker;

  constructor(path: string, token: string, asker: Asker) {
    this.#path = path;
    this.#token = token;
    this.#asker = asker;
  }

  /** Адрес двери для HTTP-проверки доступа. */
  http(base: string): URL {
    return new URL(this.#path, base);
  }

  /** Адрес двери для WebSocket. */
  socket(base: string): URL {
    const url = this.http(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }

  /** Заголовок с токеном для HTTP-проверки. */
  headers(): HeadersInit {
    return { Authorization: `Bearer ${this.#token}` };
  }

  /** Подпротоколы: браузерная форма, `bearer.*` сервер не выбирает. */
  protocols(): string[] {
    return ["mpu", `bearer.${this.#token}`];
  }

  /**
   * Первый кадр: слова, место и контекст вызова
   * (`platform/call-context.md`). Есть ли кого спросить — отдельный
   * факт, из терминальности кадра он не выводится: на `/agent/line`
   * спросить некого при любом терминале.
   */
  first(
    words: readonly string[],
    cwd: string,
    context: ContextFields,
  ): FirstFrame {
    return { words, cwd, human: this.#asker.present, ...context };
  }

  answer(question: string): Promise<string> {
    return this.#asker.answer(question);
  }
}

/**
 * Дверь по доступным токенам: основной читается — `/line` с тем, кто
 * отвечает; иначе агентский — `/agent/line`, спросить некого; ни одного —
 * `undefined`.
 *
 * @param main основной токен; не читается — `undefined`
 * @param agent агентский токен; не читается — `undefined`
 * @param asker кто отвечает при основном токене
 */
export function chooseDoor(
  main: string | undefined,
  agent: string | undefined,
  asker: Asker,
): Door | undefined {
  if (main !== undefined) return new Door("/line", main, asker);
  if (agent !== undefined) return new Door("/agent/line", agent, NOBODY);
  return undefined;
}
