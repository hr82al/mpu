/**
 * Сеанс sl-back (`platform/slback-http.md`): получение токена через
 * кэш порта и вызов эндпоинта с ним.
 *
 * Кэш и логин живут вместе, потому что вместе они и работают: вызывающий
 * просит токен, а откуда он пришёл — из кэша или из `POST /auth/login` —
 * его не касается. Часы приходят параметром: срок годности записи
 * проверяется в тестах без ожидания стеной.
 */

import { slbackCall, SlbackError } from "./client.ts";
import { cachedToken, tokenCacheText } from "./token.ts";

/** Креды логина — тело `POST /auth/login`. */
export interface SlbackCredentials {
  readonly email: string;
  readonly password: string;
}

/**
 * Что сеансу нужно снаружи: адрес, креды и обе стороны кэша токена.
 *
 * Адрес и креды — функциями, а не значениями: сеанс спрашивает их только
 * перед сетью. Вызывающему, которому хватило живого кэша, отсутствующий
 * адрес не мешает, а отказ адреса или кред приходит до первого запроса — и
 * тем классом, которым его бросил порт.
 */
export interface SlbackPort {
  /** Базовый URL sl-back без хвостового `/`, к нему приклеивается путь. */
  readonly baseUrl: () => string;
  /** Креды логина; заданное поле `overrides` старше прочих источников. */
  readonly credentials: (overrides: CredentialOverrides) => SlbackCredentials;
  /** Текст записи кэша; кэша нет — `undefined`. */
  readonly readTokenCache: () => Promise<string | undefined>;
  /** Записать текст кэша; отказ сеанс не роняет (запись best-effort). */
  readonly writeTokenCache: (text: string) => Promise<void>;
}

/**
 * Логин прошёл, но токена в ответе нет. Отдельный класс, а не текст:
 * `mpu api get-token` называет этот случай своими словами (`api.md`),
 * все прочие команды — словами атома.
 */
export class NoAccessTokenError extends SlbackError {
  override name = "NoAccessTokenError";
}

/** Явные креды вызова: заданное поле старше прочих источников (`api.md`). */
export interface CredentialOverrides {
  readonly email?: string;
  readonly password?: string;
}

/** Сеанс: токен и вызов эндпоинта. */
export interface SlbackSession {
  /**
   * Токен: живая запись кэша либо свежий логин с записью кэша.
   * `useCache: false` — читать кэш нельзя, но перезаписать надо: так
   * `get-token` с обоими флагами меняет пользователя в кэше.
   */
  readonly token: (opts?: {
    readonly overrides?: CredentialOverrides;
    readonly useCache?: boolean;
  }) => Promise<string>;
  /**
   * Вызов эндпоинта под Bearer-токеном; результат — разобранный JSON.
   *
   * `auth: false` — вызов без заголовка и **без единого обращения к
   * кэшу токена**: у эндпоинта с признаком `no_auth` авторизации нет
   * по построению, а `/auth/login` иначе брал бы токен, чтобы за
   * токеном сходить (`api-write.md`).
   */
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    opts?: { readonly auth?: boolean },
  ) => Promise<unknown>;
}

/** Часы сеанса в секундах; подменяются в тестах. */
export type Clock = () => number;

const systemClock: Clock = () => Math.floor(Date.now() / 1000);

/** Сеанс над портом `port`; `now` — часы срока годности записи кэша. */
export function openSlback(
  port: SlbackPort,
  now: Clock = systemClock,
): SlbackSession {
  const token: SlbackSession["token"] = async (opts = {}) => {
    if (opts.useCache !== false) {
      const cached = cachedToken(await port.readTokenCache(), now());
      if (cached !== undefined) return cached;
    }
    const credentials = port.credentials(opts.overrides ?? {});
    const response = await slbackCall(port.baseUrl(), {
      method: "POST",
      path: "/auth/login",
      body: credentials,
    });
    const fresh = accessTokenOf(response);
    // Запись кэша — best-effort: токен уже получен, и отказ каталога не
    // должен ронять вызов, ради которого он получен (вердикт fix
    // `platform/slback-http.md`).
    try {
      await port.writeTokenCache(tokenCacheText(fresh, now()));
    } catch {
      // Причина не важна: следующий вызов просто сходит за токеном ещё раз.
    }
    return fresh;
  };

  return {
    token,
    call: async (method, path, body, opts) =>
      await slbackCall(port.baseUrl(), {
        method,
        path,
        body,
        // Токен берётся только там, где он нужен: у `auth: false`
        // обращения к кэшу не происходит вовсе, а не «происходит и
        // не используется».
        token: opts?.auth === false ? undefined : await token(),
      }),
  };
}

/**
 * Непустой `accessToken` из ответа логина; иначе — отказ, названный по
 * полю. Тела ответа в тексте нет: ответ логина несёт секрет, и под другим
 * именем поля (сервер его переименовал) тело выдало бы токен.
 */
function accessTokenOf(response: unknown): string {
  const value =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).accessToken
      : undefined;
  if (typeof value === "string" && value !== "") return value;
  throw new NoAccessTokenError("sl-back login: нет accessToken в ответе");
}
