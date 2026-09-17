/**
 * Подключения семейства копирований (`copy-client.md`, `copy-dev.md`,
 * «Конфигурация»): источник — прод либо dev, назначение — всегда
 * локальные контейнеры.
 *
 * Хост назначения зашит `127.0.0.1` и не настраивается ни ключом, ни
 * флагом: это единственная страховка от того, чтобы копия с прода
 * ушла обратно в прод. Селектор влияет только на источник.
 */

import { UsageError } from "../command/mod.ts";
import type { EnvFile } from "../command/mod.ts";
import type { PgTarget } from "../sql/mod.ts";

/** Хост локальных приёмников; не настраивается (спека). */
export const LOCAL_HOST = "127.0.0.1";

/** Срез env-файла: чтение ключей и обязательный ключ. */
export type EnvKeys = Pick<EnvFile, "get" | "require">;

/**
 * Локальные контейнеры по порту приёмника. Нужны для отказа: без них
 * оператор видит `connection refused` и гадает, какой из трёх
 * контейнеров стенда не поднят.
 */
export const LOCAL_CONTAINERS: Readonly<Record<number, string>> = {
  5441: "mp-sl-1-pg",
  5440: "mp-sl-0-pg",
  5451: "mp-sw-pg",
};

/** Значение ключа; пустое равнозначно отсутствию (слой env-файла). */
export function value(env: EnvKeys, name: string): string | undefined {
  const raw = env.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Обязательный ключ. Отказ слоя — доменная ошибка, а спека велит
 * отвечать на неполную конфигурацию кодом 2: класс переворачивается,
 * текст слоя сохраняется.
 */
export function required(env: EnvKeys, name: string): string {
  try {
    return env.require(name);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err), {
      cause: err,
    });
  }
}

/** Первый непустой из двух ключей; второй — общий, первый — личный. */
export function either(env: EnvKeys, first: string, second: string): string {
  return value(env, first) ?? required(env, second);
}

/** Целое из ключа; мусор — ошибка ввода, а не молчаливое умолчание. */
export function port(env: EnvKeys, name: string, fallback: number): number {
  const raw = value(env, name);
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0 || number > 65535) {
    throw new UsageError(`${name} ожидает порт 1–65535, получено "${raw}"`);
  }
  return number;
}

/** Прод-инстанс `sl-N` как источник: адрес из ключа `pg_<N>`. */
export function sourceTarget(env: EnvKeys, serverNumber: number): PgTarget {
  return {
    host: required(env, `pg_${serverNumber}`),
    port: port(env, "PG_PORT", 5432),
    database: value(env, "PG_DB_NAME") ?? "wb",
    // Личные креды приоритетнее общих (`platform/env-file.md`).
    username: either(env, "PG_MY_USER_NAME", "PG_MAIN_USER_NAME"),
    password: either(env, "PG_MY_USER_PASSWORD", "PG_MAIN_USER_PASSWORD"),
  };
}

/** Dev sl-PG как источник режима клиента `copy-dev`. */
export function devSourceTarget(env: EnvKeys): PgTarget {
  return {
    host: value(env, "DEV_PG_HOST") ?? "192.168.150.40",
    port: port(env, "DEV_PG_PORT", 5434),
    database: value(env, "DEV_PG_DB") ?? "mp_sl_1_dev",
    username: either(env, "DEV_PG_USER", "PG_MAIN_USER_NAME"),
    password: either(env, "DEV_PG_PASSWORD", "PG_PASSWORD"),
  };
}

/** Dev-БД воркспейсов: источник режима полной БД; fallback'ов нет. */
export function devWorkspacesTarget(env: EnvKeys): PgTarget {
  return {
    host: value(env, "DEV_WORKSPACES_HOST") ?? "192.168.150.41",
    port: port(env, "DEV_WORKSPACES_PORT", 5432),
    database: value(env, "DEV_WORKSPACES_DB") ?? "workspaces",
    username: required(env, "DEV_WORKSPACES_USER"),
    password: required(env, "DEV_WORKSPACES_PASSWORD"),
  };
}

/** Локальный sl-1: схема клиента и public-строки. */
export function localSl1(env: EnvKeys): PgTarget {
  return {
    host: LOCAL_HOST,
    port: port(env, "PG_LOCAL_PORT", 5441),
    database: value(env, "PG_DB_NAME") ?? "wb",
    username: value(env, "PG_MAIN_USER_NAME") ?? "wb_plus_db_admin",
    password: either(env, "PG_MAIN_USER_PASSWORD", "PG_PASSWORD"),
  };
}

/** Локальный sl-0: клиенты и токены. */
export function localSl0(env: EnvKeys): PgTarget {
  return { ...localSl1(env), port: port(env, "PG_LOCAL_MAIN_PORT", 5440) };
}

/** Локальная БД воркспейсов: вход в sw-front. */
export function localWorkspaces(env: EnvKeys): PgTarget {
  return {
    host: LOCAL_HOST,
    port: port(env, "LOCAL_WORKSPACES_PORT", 5451),
    database: value(env, "LOCAL_WORKSPACES_DB") ?? "workspaces",
    username: value(env, "LOCAL_WORKSPACES_USER") ?? "workspacesapp",
    password: value(env, "LOCAL_WORKSPACES_PASSWORD") ?? "postgres",
  };
}

/**
 * Отказ подключения к локальному приёмнику: называет контейнер и то,
 * чем его поднять. Сырой `connection refused` оставлял бы оператора
 * гадать, какой из трёх контейнеров стенда не запущен.
 */
export function localUnreachable(target: PgTarget, cause: unknown): UsageError {
  const container = LOCAL_CONTAINERS[target.port] ?? `порт ${target.port}`;
  const reason = cause instanceof Error ? cause.message.split("\n")[0] : "";
  return new UsageError(
    `локальный ${container} недоступен (${target.host}:${target.port})` +
      (reason === "" ? "" : `: ${reason}`),
    { hint: "подними стенд: mpu mp-init" },
  );
}
