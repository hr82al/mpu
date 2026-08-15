/**
 * Куда идёт вызов `mpu sql-ro`: маршрут по селектору (`specs/sql-ro.md`,
 * «CLI-контракт») и адрес подключения с кредами из env-файла
 * (`platform/env-file.md`).
 *
 * Ошибка конфигурации — ошибка ввода (exit 2, спека), а не доменная:
 * текст слоя env-файла сохраняется дословно, меняется только класс.
 */

import { DomainError, type EnvFile, UsageError } from "../command/mod.ts";

/** Порт PG стенда по умолчанию (`platform/env-file.md`). */
const DEFAULT_PORT = 5432;

/** Имя БД стенда по умолчанию (`platform/env-file.md`). */
const DEFAULT_DATABASE = "wb";

/** Порт и БД dry-стенда по умолчанию: значения эталона `dry-v-dev`. */
const DEFAULT_DEV_PORT = 5434;
const DEFAULT_DEV_DATABASE = "mp_sl_1_dev";

/**
 * Алиасы БД воркспейсов (`platform/selector.md`): сравниваются без учёта
 * регистра и краевых пробелов.
 */
const SW_ALIASES: readonly string[] = [
  "sw",
  "sw-pg",
  "swpg",
  "sw-back",
  "swback",
  "ws",
  "workspaces",
];

/** Префикс селектора dev-стенда. */
const DEV_PREFIX = "dev:";

/** Целое без знака: хвост dev-селектора, если он число. */
const CLIENT_ID = /^\d+$/;

/**
 * Маршрут вызова: первое совпадение побеждает (спека). `normal` —
 * единственный, где селектор резолвится платформенным резолвом.
 */
export type SelectorRoute =
  /** dev-стенд; хвост-число — client_id для search_path, иначе его нет. */
  | { readonly kind: "dev"; readonly clientId: number | null }
  /** БД воркспейсов: до `specs/sql-sw.md` вызов уходит прежней реализации. */
  | { readonly kind: "sw" }
  | { readonly kind: "normal" };

/** Маршрут по строке селектора; разбора кэша здесь нет. */
export function routeOf(selector: string): SelectorRoute {
  if (selector.startsWith(DEV_PREFIX)) {
    const tail = selector.slice(DEV_PREFIX.length);
    return {
      kind: "dev",
      clientId: CLIENT_ID.test(tail) ? Number(tail) : null,
    };
  }
  return SW_ALIASES.includes(selector.trim().toLowerCase())
    ? { kind: "sw" }
    : { kind: "normal" };
}

/** Адрес и креды подключения; в мета-блок уходит всё, кроме кредов. */
export interface PgTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

/** Ключи env-файла глазами подключения. */
type EnvKeys = Pick<EnvFile, "get" | "require">;

/** Адрес сервера стенда `sl-<N>`. */
export function serverTarget(env: EnvKeys, serverNumber: number): PgTarget {
  return {
    host: required(env, `pg_${serverNumber}`),
    port: portOf(env, "PG_PORT", DEFAULT_PORT),
    database: value(env, "PG_DB_NAME") ?? DEFAULT_DATABASE,
    // Личные креды приоритетнее общих (`platform/env-file.md`), каждый
    // ключ независимо: пары «имя+пароль» слой не знает.
    username: either(env, "PG_MY_USER_NAME", "PG_MAIN_USER_NAME"),
    password: either(env, "PG_MY_USER_PASSWORD", "PG_MAIN_USER_PASSWORD"),
  };
}

/** Адрес dev-стенда: одна БД на всех клиентов, свои креды. */
export function devTarget(env: EnvKeys): PgTarget {
  return {
    host: required(env, "DEV_PG_HOST"),
    port: portOf(env, "DEV_PG_PORT", DEFAULT_DEV_PORT),
    database: value(env, "DEV_PG_DB") ?? DEFAULT_DEV_DATABASE,
    username: required(env, "DEV_PG_USER"),
    password: required(env, "DEV_PG_PASSWORD"),
  };
}

/** Значение ключа; пустое равнозначно отсутствию (спека слоя). */
function value(env: EnvKeys, name: string): string | undefined {
  const raw = env.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Обязательный ключ. Текст отсутствия — слоя env-файла дословно, класс
 * ошибки — ввода: спека команды даёт конфигурации exit 2, а слой бросает
 * доменную ошибку (exit 1).
 */
function required(env: EnvKeys, name: string): string {
  try {
    return env.require(name);
  } catch (err) {
    if (err instanceof DomainError) {
      throw new UsageError(err.message, { cause: err });
    }
    throw err;
  }
}

function either(env: EnvKeys, personal: string, common: string): string {
  const raw = value(env, personal);
  return raw ?? required(env, common);
}

function portOf(env: EnvKeys, name: string, fallback: number): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new UsageError(`${name}: ожидался номер порта, задано '${raw}'`);
  }
  return port;
}
