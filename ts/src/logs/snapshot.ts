/**
 * Legacy-путь `--via portainer` (`docs/specs/logs.md`): снимок логов
 * одного контейнера из Docker API через Portainer. Это GET за уже
 * записанным логом, а не exec, — поэтому транспорта выполнения здесь
 * нет вовсе.
 *
 * Шаги: цель сервера (кэш, иначе legacy-ключ env) → имя контейнера
 * (точное совпадение побеждает подстроку) → запрос логов.
 */

import { type EnvFile, UsageError } from "../command/mod.ts";
import type { ContainerLogsQuery, PortainerAccess } from "../portainer/mod.ts";
import type { LogsCache, PortainerTarget } from "./cache.ts";
import { portainerFailure } from "./failure.ts";
import type { ListContainerNames, ReadContainerLogs } from "./sources.ts";

/** Чем снимок пользуется: кэш, env-слой и две границы Portainer. */
export interface SnapshotDeps {
  readonly cache: LogsCache;
  readonly env: EnvFile;
  readonly names: ListContainerNames;
  readonly logs: ReadContainerLogs;
}

/** Снимок: чьи логи получены и что пришло по каждому потоку. */
export interface SnapshotOutcome {
  readonly container: string;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Снимок логов контейнера сервера `serverNumber`; `wanted` — точное имя
 * контейнера либо подстрока имени.
 */
export async function readSnapshot(
  deps: SnapshotDeps,
  serverNumber: number,
  wanted: string,
  query: ContainerLogsQuery,
): Promise<SnapshotOutcome> {
  const apiKey = requireApiKey(deps.env);
  const target = requireTarget(deps, serverNumber);
  const access: PortainerAccess = {
    baseUrl: target.baseUrl.replace(/\/+$/, ""),
    apiKey,
    // Сертификат проверяется только по явному «true» — умолчание стенда
    // самоподписанное (`platform/exec-transport.md`).
    verifyTls: deps.env.get("PORTAINER_VERIFY_TLS")?.toLowerCase() === "true",
  };
  const decoder = new TextDecoder();
  try {
    const names = await deps.names(access, target.endpointId);
    const container = pickContainer(names, wanted, serverNumber);
    const streams = await deps.logs(
      access,
      target.endpointId,
      container,
      query,
    );
    return {
      container,
      stdout: decoder.decode(streams.stdout),
      stderr: decoder.decode(streams.stderr),
    };
  } catch (err) {
    throw portainerFailure(err);
  }
}

/** Ключ доступа: обязателен и проверяется до всякой сети. */
function requireApiKey(env: EnvFile): string {
  const apiKey = env.get("PORTAINER_API_KEY");
  if (apiKey === undefined || apiKey === "") {
    throw new UsageError("PORTAINER_API_KEY не задан в ~/.config/mpu/.env");
  }
  return apiKey;
}

/** Цель сервера: строка кэша, иначе legacy-ключ env-файла. */
function requireTarget(
  deps: SnapshotDeps,
  serverNumber: number,
): PortainerTarget {
  const target = deps.cache.portainerTarget(serverNumber) ??
    targetFromEnv(deps.env, serverNumber);
  if (target === undefined) {
    throw new UsageError(
      `для sl-${serverNumber} не найден portainer-target (SQLite после ` +
        `\`mpu init\` или sl_${serverNumber}_portainer в ~/.config/mpu/.env)`,
    );
  }
  return target;
}

/**
 * Legacy-ключ `sl_<N>_portainer=<base_url>/<endpoint_id>`: id — после
 * последнего `/`. Битое значение (нет `/`, нечисловой id, пустая база)
 * означает отсутствие цели, а не ошибку разбора.
 */
function targetFromEnv(
  env: EnvFile,
  serverNumber: number,
): PortainerTarget | undefined {
  const raw = env.get(`sl_${serverNumber}_portainer`);
  if (raw === undefined) return undefined;
  const cut = raw.lastIndexOf("/");
  const baseUrl = cut === -1 ? "" : raw.slice(0, cut);
  const endpointId = cut === -1 ? "" : raw.slice(cut + 1);
  if (baseUrl === "" || !/^\d+$/.test(endpointId)) return undefined;
  return { baseUrl, endpointId: Number(endpointId) };
}

/**
 * Имя контейнера: точное совпадение побеждает; иначе подстрока, и она
 * обязана дать ровно одного кандидата.
 */
function pickContainer(
  names: readonly string[],
  wanted: string,
  serverNumber: number,
): string {
  if (names.includes(wanted)) return wanted;
  const matched = [...new Set(names.filter((name) => name.includes(wanted)))]
    .sort();
  if (matched.length === 1) return matched[0];
  if (matched.length === 0) {
    throw new UsageError(
      `контейнер '${wanted}' не найден на sl-${serverNumber}`,
      { details: `  подсказка: mpu ps sl-${serverNumber}` },
    );
  }
  throw new UsageError(
    `подстрока '${wanted}' даёт несколько контейнеров на sl-${serverNumber}:`,
    { details: matched.map((name) => `  ${name}`).join("\n") },
  );
}
