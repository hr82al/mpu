/**
 * Вход в браузере (`specs/web.md`, «Вход в браузере (10a)»): ключи — в
 * памяти на 60 с, сессии — sha256 со сроком 12 ч в файле `web-sessions`
 * (0600). Из прочитанного файла войти нельзя: в нём только хэши.
 */

import type { SecretText } from "../runtime/mod.ts";

/** Срок ключа из ссылки `web`. */
export const KEY_TTL_MS = 60_000;
/** Срок сессии (`Max-Age` cookie). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 32 шестнадцатеричных знака. */
function randomHex(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Что нужно хранилищу снаружи. */
export interface WebParts {
  /** Файл сессий (`$HOME/.config/mpu/web-sessions`). */
  readonly file: SecretText;
  /** Текущее время, мс. */
  readonly now: () => number;
}

/** Ключи и сессии входа в браузере. */
export class WebAccess {
  readonly #file: SecretText;
  readonly #now: () => number;
  /** Ключ → конец срока. */
  readonly #keys = new Map<string, number>();
  /** sha256 сессии → конец срока. */
  #sessions = new Map<string, number>();

  private constructor(parts: WebParts) {
    this.#file = parts.file;
    this.#now = parts.now;
  }

  /** Хранилище с сессиями из файла (просроченные отброшены). */
  static async open(parts: WebParts): Promise<WebAccess> {
    const access = new WebAccess(parts);
    for (const row of (await parts.file.read()).split("\n")) {
      const [hash, until] = row.split(" ");
      const end = Number(until);
      if (/^[0-9a-f]{64}$/.test(hash ?? "") && end > parts.now()) {
        access.#sessions.set(hash, end);
      }
    }
    return access;
  }

  /** Одноразовый ключ на 60 с. */
  issueKey(): string {
    const key = randomHex();
    this.#keys.set(key, this.#now() + KEY_TTL_MS);
    return key;
  }

  /**
   * Сессия в обмен на ключ; ключ гасится. Ключа нет или истёк —
   * `undefined`.
   */
  async exchange(key: string): Promise<string | undefined> {
    const until = this.#keys.get(key);
    this.#keys.delete(key);
    if (until === undefined || until <= this.#now()) return undefined;
    const session = randomHex();
    this.#sessions.set(await sha256(session), this.#now() + SESSION_TTL_MS);
    await this.#save();
    return session;
  }

  /** Действует ли сессия из cookie. */
  async admits(session: string): Promise<boolean> {
    const until = this.#sessions.get(await sha256(session));
    return until !== undefined && until > this.#now();
  }

  /** Гасит все сессии и ключи; число — погашенных сессий. */
  async logout(): Promise<number> {
    const count = this.#sessions.size;
    this.#sessions = new Map();
    this.#keys.clear();
    await this.#save();
    return count;
  }

  #save(): Promise<void> {
    const rows = [...this.#sessions].map(([hash, until]) =>
      `${hash} ${until}\n`
    );
    return this.#file.write(rows.join(""));
  }
}
