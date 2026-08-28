/**
 * Сеанс sl-back (`platform/slback-http.md`): получение токена через
 * файловый кэш и вызов эндпоинта с ним.
 *
 * Кэш и логин живут вместе, потому что вместе они и работают: команда
 * просит токен, а откуда он пришёл — из файла или из `POST /auth/login` —
 * её не касается. Часы приходят параметром: срок годности записи
 * проверяется в тестах без ожидания стеной.
 */

import type { CommandIo } from "../command/mod.ts";
import { RESPONSE_LIMIT, slbackCall, SlbackError, truncate } from "./client.ts";
import { slbackBaseUrl, slbackCredentials } from "./config.ts";
import { cachedToken, tokenCacheText } from "./token.ts";

/** Срез порта: env-файл и обе стороны токен-кэша. */
export type SlbackIo = Pick<
  CommandIo,
  "envFile" | "readTokenCache" | "writeTokenCache"
>;

/**
 * Логин прошёл, но токена в ответе нет. Отдельный класс, а не текст:
 * `mpu api get-token` называет этот случай своими словами (`api.md`),
 * все прочие команды — словами атома.
 */
export class NoAccessTokenError extends SlbackError {
  override name = "NoAccessTokenError";
}

/** Явные креды вызова: заданное поле старше env (`api.md`). */
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
  readonly token: (
    opts?: {
      readonly overrides?: CredentialOverrides;
      readonly useCache?: boolean;
    },
  ) => Promise<string>;
  /** Вызов эндпоинта под Bearer-токеном; результат — разобранный JSON. */
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<unknown>;
}

/** Часы сеанса в секундах; подменяются в тестах. */
export type Clock = () => number;

const systemClock: Clock = () => Math.floor(Date.now() / 1000);

export function openSlback(
  io: SlbackIo,
  now: Clock = systemClock,
): SlbackSession {
  const token: SlbackSession["token"] = async (opts = {}) => {
    if (opts.useCache !== false) {
      const cached = cachedToken(await io.readTokenCache(), now());
      if (cached !== undefined) return cached;
    }
    const credentials = slbackCredentials(io.envFile, opts.overrides ?? {});
    const response = await slbackCall(slbackBaseUrl(io.envFile), {
      method: "POST",
      path: "/auth/login",
      body: credentials,
    });
    const fresh = accessTokenOf(response);
    // Запись кэша — best-effort: токен уже получен, и отказ каталога не
    // должен ронять вызов, ради которого он получен (вердикт fix
    // `platform/slback-http.md`).
    try {
      await io.writeTokenCache(tokenCacheText(fresh, now()));
    } catch {
      // Причина не важна: следующий вызов просто сходит за токеном ещё раз.
    }
    return fresh;
  };

  return {
    token,
    call: async (method, path, body) =>
      await slbackCall(slbackBaseUrl(io.envFile), {
        method,
        path,
        body,
        token: await token(),
      }),
  };
}

/** Непустой `accessToken` из ответа логина; иначе — отказ с телом ответа. */
function accessTokenOf(response: unknown): string {
  const value = typeof response === "object" && response !== null
    ? (response as Record<string, unknown>)["accessToken"]
    : undefined;
  if (typeof value === "string" && value !== "") return value;
  throw new NoAccessTokenError(
    `sl-back login: нет accessToken в ответе: ${
      truncate(JSON.stringify(response) ?? "", RESPONSE_LIMIT)
    }`,
  );
}
