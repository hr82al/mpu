/**
 * Адрес и креды sl-back (`platform/slback-http.md`, «Ввод/вывод»):
 * резолв базового URL по двум ключам env-файла и проверка кред логина.
 *
 * Отдельно от вызова: обе проверки — до сети, и оба текста отказа
 * дословны в спеке, поэтому проверяются без поднятого сервера.
 */

import { DomainError, type EnvFile } from "../command/mod.ts";

/**
 * Путь env-файла в текстах отказов. Литералом, как у соседей
 * (`src/logs/cmd_logs.ts`, `src/init/cmd_init.ts`): слой env-файла
 * своего пути наружу не отдаёт, а вычислять его второй раз из
 * окружения значило бы завести второе правило рядом с
 * `envFilePath` — и разойтись с ним.
 */
export const ENV_FILE_HINT = "~/.config/mpu/.env";

/** Ключ полного URL либо префикса пути. */
export const BASE_URL_KEY = "BASE_API_URL";
/** Ключ хоста; обязателен, когда `BASE_API_URL` — не полный URL. */
export const HOST_KEY = "NEXT_PUBLIC_SERVER_URL";
/** Ключи кред `POST /auth/login`. */
export const EMAIL_KEY = "TOKEN_EMAIL";
export const PASSWORD_KEY = "TOKEN_PASSWORD";

/** Значение ключа env-файла; пустое равнозначно незаданному. */
function value(envFile: EnvFile, name: string): string | undefined {
  const raw = envFile.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Базовый URL sl-back: первое правило спеки с выполненным условием.
 *
 * Хвостовой `/` срезается там и только там, где это названо в спеке:
 * у полного URL и у одинокого хоста. В склейке «хост + path-префикс»
 * срезаются лишь ведущие слэши префикса — значит `BASE_API_URL=/api/`
 * даёт базу с хвостовым слэшем, и путь запроса приклеится к ней через
 * `//`. Это буква спеки (`platform/slback-http.md`, правило 2), и
 * трогать её здесь нельзя: адрес обязан совпадать с адресом прежней
 * реализации побайтно, иначе differential будет сравнивать разные
 * запросы.
 */
export function slbackBaseUrl(envFile: EnvFile): string {
  const base = value(envFile, BASE_URL_KEY);
  const host = value(envFile, HOST_KEY);
  if (base !== undefined && base.startsWith("http")) return trimEnd(base);
  if (base !== undefined && host !== undefined) {
    return `${trimEnd(host)}/${base.replace(/^\/+/, "")}`;
  }
  if (host !== undefined) return trimEnd(host);
  throw new DomainError(
    `sl-back base URL не задан. Поставь ${BASE_URL_KEY} (full URL) или ` +
      `${HOST_KEY} (host) + ${BASE_URL_KEY} (path) в ${ENV_FILE_HINT}`,
  );
}

function trimEnd(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Креды логина. */
export interface SlbackCredentials {
  readonly email: string;
  readonly password: string;
}

/**
 * Креды из env-файла; недостающие ключи названы все сразу — оператор
 * правит файл один раз, а не по одному ключу за прогон.
 *
 * `overrides` — явные `--email`/`--password` команды `get-token`: по
 * своему полю флаг побеждает env (`api.md`, «Граничные случаи»), и
 * ключ, закрытый флагом, недостающим уже не считается.
 */
export function slbackCredentials(
  envFile: EnvFile,
  overrides: Partial<SlbackCredentials> = {},
): SlbackCredentials {
  const email = blank(overrides.email) ?? value(envFile, EMAIL_KEY);
  const password = blank(overrides.password) ?? value(envFile, PASSWORD_KEY);
  const missing: string[] = [];
  if (email === undefined) missing.push(EMAIL_KEY);
  if (password === undefined) missing.push(PASSWORD_KEY);
  // Условие повторяет два `push` выше не ради красоты, а ради сужения
  // типа: массив имён компилятору ничего о значениях не говорит.
  if (email === undefined || password === undefined) {
    throw new DomainError(
      `sl-back credentials missing: ${missing.join(", ")}. ` +
        `Add to ${ENV_FILE_HINT} or export in shell.`,
    );
  }
  return { email, password };
}

/** Пустая строка равнозначна незаданному значению — как и в env-файле. */
function blank(text: string | undefined): string | undefined {
  return text === undefined || text === "" ? undefined : text;
}
