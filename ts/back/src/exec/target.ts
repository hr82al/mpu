/**
 * Куда и каким транспортом уходит команда (`platform/exec-transport.md`,
 * «Выбор транспорта для сервера N»). Бэкенды взаимоисключающие, выбор —
 * per-server и делается один раз здесь: сами бэкенды получают готовый
 * таргет и о конфигурации не знают.
 *
 * Все отказы — ошибки ввода (exit 2 по спеке): это конфигурация, а не
 * сбой внешней системы. Имени вызвавшей команды слой не знает — префикс
 * `mpu <команда>:` добавляет форматирование ошибки, и потому `mpu run-js`
 * больше не жалуется от чужого имени (спека, «Известные отклонения»).
 */

import { type EnvFile, UsageError } from "../command/mod.ts";
import type { PortainerAccess } from "../portainer/mod.ts";
import type { CacheReader } from "../selector/mod.ts";
import {
  type ContainerLocation,
  serverCliContainer,
  serverLocation,
} from "./containers.ts";

/** Dev-нода в Portainer-ферму не входит и достаётся только по ssh (спека). */
const DEV_HOST = "192.168.150.8";
const DEV_USER = "develop";

/** Ключи env-файла глазами выбора транспорта. */
type EnvKeys = Pick<EnvFile, "get">;

/** Override транспорта серверных таргетов. */
export type Via = "ssh" | "portainer";

/** Куда адресован вызов — до выбора транспорта. */
export type ExecPlace =
  /** cli-контейнер сервера фермы; имя — из кэша (`containers.ts`). */
  | { readonly kind: "server"; readonly serverNumber: number }
  /** cli-контейнер на dev-ноде: там имя всегда `mp-sl-<N>-cli` (спека). */
  | { readonly kind: "dev"; readonly serverNumber: number }
  /** Контейнер по точному имени: где он лежит, уже известно из кэша. */
  | { readonly kind: "container"; readonly location: ContainerLocation };

/** Готовый адрес исполнения: бэкенд выбран, конфигурация прочитана. */
export type ExecTarget =
  | {
    readonly kind: "ssh";
    readonly host: string;
    readonly user: string;
    readonly container: string;
  }
  | {
    readonly kind: "portainer";
    readonly access: PortainerAccess;
    readonly endpointId: number;
    readonly container: string;
  };

/** Откуда выбор транспорта берёт всё, что ему нужно. */
export interface TransportSources {
  readonly place: ExecPlace;
  readonly env: EnvKeys;
  readonly cache: CacheReader;
  readonly via?: Via;
}

/**
 * Portainer-доступ сервера: что нашлось и чего не хватило. Тексты
 * отказов принадлежат командам (`specs/ps.md`), поэтому слой отвечает
 * различимыми исходами, а не сообщением.
 */
export type PortainerLookup =
  | {
    readonly kind: "ok";
    readonly access: PortainerAccess;
    readonly endpointId: number;
  }
  /** Ключ есть, но сервер не найден ни в кэше, ни в env-fallback'е. */
  | { readonly kind: "no-target" }
  | { readonly kind: "no-key" };

/**
 * Portainer-доступ сервера N: строка кэша старше env-fallback'а. Тот же
 * порядок, что и у выбора транспорта, — иначе `mpu ps` и `mpu ssh`
 * ходили бы на разные endpoint'ы одного сервера.
 */
export function portainerOf(
  env: EnvKeys,
  cache: CacheReader,
  serverNumber: number,
): PortainerLookup {
  const apiKey = value(env, "PORTAINER_API_KEY");
  if (apiKey === undefined) return { kind: "no-key" };
  const location = serverLocation(cache, serverNumber) ??
    fallbackLocation(env, serverNumber);
  if (location === null) return { kind: "no-target" };
  return {
    kind: "ok",
    access: accessOf(location.portainerUrl, apiKey, env),
    endpointId: location.endpointId,
  };
}

/**
 * Portainer-доступ либо отказ конфигурации с текстом обеих команд:
 * `specs/health.md` требует «тексты — как у `mpu ps`», а два места
 * правки разъехались бы молча.
 */
export function requirePortainer(
  env: EnvKeys,
  cache: CacheReader,
  serverNumber: number,
): Extract<PortainerLookup, { kind: "ok" }> {
  const found = portainerOf(env, cache, serverNumber);
  if (found.kind === "no-key") {
    throw new UsageError("PORTAINER_API_KEY не задан в ~/.config/mpu/.env");
  }
  if (found.kind === "no-target") {
    throw new UsageError(
      `для sl-${serverNumber} не найден portainer-target` +
        ` (SQLite после \`mpu init\` или sl_${serverNumber}_portainer в` +
        " ~/.config/mpu/.env)",
    );
  }
  return found;
}

/** Значение `--via`; флага нет — override'а нет. */
export function viaOf(raw: string | undefined): Via | undefined {
  if (raw === undefined) return undefined;
  if (raw === "ssh" || raw === "portainer") return raw;
  throw new UsageError(
    `--via должен быть ssh|portainer, получено '${raw}'`,
  );
}

/** Транспорт вызова; отказ — конфигурация, которой не хватает. */
export function chooseTransport(sources: TransportSources): ExecTarget {
  const { place, env, cache, via } = sources;
  switch (place.kind) {
    case "dev":
      // Выбора здесь нет, поэтому и override не участвует: до dev-ноды
      // ведёт только ssh (спека).
      return {
        kind: "ssh",
        host: value(env, "DEV_NODE_HOST") ?? DEV_HOST,
        user: value(env, "DEV_NODE_USER") ?? DEV_USER,
        container: devCliContainer(place.serverNumber),
      };
    case "container":
      return containerTarget(place.location, env, via);
    case "server":
      return serverTarget(place.serverNumber, env, cache, via);
  }
}

/**
 * Контейнер по точному имени живёт где угодно на ферме, а ssh знает
 * только про cli-контейнер своего сервера — отсюда инвариант «контейнер
 * по имени никогда не исполняется по ssh» (спека).
 */
function containerTarget(
  location: ContainerLocation,
  env: EnvKeys,
  via: Via | undefined,
): ExecTarget {
  if (via === "ssh") {
    throw new UsageError(
      "--via ssh не поддерживается для контейнера по имени; только для sl-N",
    );
  }
  const apiKey = value(env, "PORTAINER_API_KEY");
  if (apiKey === undefined) {
    throw new UsageError("PORTAINER_API_KEY не задан в ~/.config/mpu/.env");
  }
  return {
    kind: "portainer",
    access: accessOf(location.portainerUrl, apiKey, env),
    endpointId: location.endpointId,
    container: location.containerName,
  };
}

/**
 * Сервер фермы: Portainer предпочитается при обоих доступных — это
 * единственный путь до всей фермы, ssh настроен не на каждый сервер.
 */
function serverTarget(
  serverNumber: number,
  env: EnvKeys,
  cache: CacheReader,
  via: Via | undefined,
): ExecTarget {
  // Имя берётся из кэша, а не собирается зашитой формой: exec обязан
  // ходить в тот контейнер, который печатает `--print`
  // (`platform/portainer.md`).
  const container = serverCliContainer(cache, serverNumber);
  const apiKey = value(env, "PORTAINER_API_KEY");
  const location = apiKey === undefined
    ? null
    : serverLocation(cache, serverNumber) ??
      fallbackLocation(env, serverNumber);
  if (via !== "ssh" && apiKey !== undefined && location !== null) {
    return {
      kind: "portainer",
      access: accessOf(location.portainerUrl, apiKey, env),
      endpointId: location.endpointId,
      container,
    };
  }
  const host = value(env, `sl_${serverNumber}`);
  const user = value(env, "PG_MY_USER_NAME");
  if (via !== "portainer" && host !== undefined && user !== undefined) {
    return { kind: "ssh", host, user, container };
  }
  throw unavailable(serverNumber, via);
}

/**
 * Отказ выбора. Запрошенный явно транспорт называется в отказе сам:
 * общий текст «не задано ни … ни …» врал бы ровно тогда, когда второй
 * транспорт как раз настроен (спека `ssh.md`, отклонение `fix`).
 */
function unavailable(serverNumber: number, via: Via | undefined): UsageError {
  if (via === "ssh") {
    return new UsageError(
      `--via ssh: для sl-${serverNumber} не задан ssh-доступ` +
        ` (sl_${serverNumber} + PG_MY_USER_NAME)`,
    );
  }
  if (via === "portainer") {
    return new UsageError(
      `--via portainer: для sl-${serverNumber} не задан Portainer` +
        ` (sl_${serverNumber}_portainer + PORTAINER_API_KEY)`,
    );
  }
  return new UsageError(
    `для sl-${serverNumber} не задано ни sl_${serverNumber}` +
      ` (+PG_MY_USER_NAME) ни sl_${serverNumber}_portainer` +
      " (+PORTAINER_API_KEY)",
  );
}

/**
 * Legacy-fallback `sl_<N>_portainer=<база>/<endpoint_id>`: endpoint_id —
 * после последнего `/`. Нечисловой id или пустая база — таргета нет, а не
 * ошибка: сервер просто считается недоступным по Portainer (спека).
 */
function fallbackLocation(
  env: EnvKeys,
  serverNumber: number,
): { readonly portainerUrl: string; readonly endpointId: number } | null {
  const raw = value(env, `sl_${serverNumber}_portainer`);
  if (raw === undefined) return null;
  const cut = raw.lastIndexOf("/");
  if (cut <= 0) return null;
  const tail = raw.slice(cut + 1);
  // Только десятичные цифры: `Number` принял бы и пустую строку (ноль), и
  // `1e3`, и `0x4`, а спека знает лишь «числовой id или таргета нет».
  // Одно и то же значение env-файла обязано давать один ответ здесь и в
  // `../logs/snapshot.ts`, где правило записано так же.
  if (!/^\d+$/.test(tail)) return null;
  return { portainerUrl: raw.slice(0, cut), endpointId: Number(tail) };
}

function accessOf(
  baseUrl: string,
  apiKey: string,
  env: EnvKeys,
): PortainerAccess {
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    // Проверку включает только явное `true` (спека), поэтому её
    // отсутствие и любое другое значение равнозначны.
    verifyTls: value(env, "PORTAINER_VERIFY_TLS")?.toLowerCase() === "true",
  };
}

/** Имя на dev-ноде: она вне фермы, кэша про неё нет (спека). */
export function devCliContainer(serverNumber: number): string {
  return `mp-sl-${serverNumber}-cli`;
}

/** Значение ключа; пустое равнозначно отсутствию (`platform/env-file.md`). */
function value(env: EnvKeys, name: string): string | undefined {
  const raw = env.get(name);
  return raw === undefined || raw === "" ? undefined : raw;
}
