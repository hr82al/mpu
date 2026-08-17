/**
 * Куда адресован вызов `mpu ssh` (`specs/ssh.md`, «CLI-контракт»):
 * собственные формы селектора команда перехватывает до базового резолва
 * (`platform/selector.md`), и тексты их отказов принадлежат ей.
 *
 * Порядок перехвата — контракт: `dev:`, затем `sl-N`, затем точное имя
 * контейнера из кэша, и только потом клиентский резолв.
 */

import { UsageError } from "../command/mod.ts";
import { containerLocations, type ExecPlace } from "../exec/mod.ts";
import {
  type CacheReader,
  resolveSelector,
  type ServerAddresses,
} from "../selector/mod.ts";

/** Префикс dev-стенда и допустимые формы его хвоста. */
const DEV_PREFIX = "dev:";
const DEV_TAIL = /^(?:sl-)?(\d+)$/;

/** Короткий цикл `sl-N` (`platform/selector.md`). */
const SERVER = /^sl-(\d+)$/;

/** Источники резолва: кэш контейнеров и адреса серверов env-файла. */
export interface PlaceSources {
  readonly cache: CacheReader;
  readonly env: ServerAddresses;
}

/** Таргет вызова по строке селектора. */
export function placeOf(selector: string, sources: PlaceSources): ExecPlace {
  if (selector.startsWith(DEV_PREFIX)) return devPlace(selector);

  const server = SERVER.exec(selector);
  if (server !== null) {
    return { kind: "server", serverNumber: Number(server[1]) };
  }

  const containers = containerLocations(sources.cache, selector);
  if (containers.length === 1) {
    return { kind: "container", location: containers[0] };
  }
  if (containers.length > 1) throw ambiguous(selector, containers);

  // Ни одна собственная форма не сработала — селектор клиентский, и
  // отказы у него общие для всех команд.
  const resolved = resolveSelector(sources, selector);
  return { kind: "server", serverNumber: resolved.serverNumber };
}

function devPlace(selector: string): ExecPlace {
  const tail = DEV_TAIL.exec(selector.slice(DEV_PREFIX.length).trim());
  if (tail === null) {
    throw new UsageError(
      "dev-селектор ожидает номер sl-сервера: `dev:N` (например dev:1)," +
        ` получено: '${selector}'`,
    );
  }
  return { kind: "dev", serverNumber: Number(tail[1]) };
}

/**
 * Одно имя на разных endpoint'ах — честная неоднозначность (спека
 * транспорта). В клиентский поиск после неё не проваливаемся: иначе
 * опечатка в имени контейнера маскировалась бы чужим ответом. Тот же
 * отказ действует внутри fan-out'а (`specs/ssh.md`): молча брать
 * первого кандидата у мутирующей команды нельзя.
 */
export function ambiguous(
  name: string,
  candidates: readonly {
    readonly endpointName: string;
    readonly endpointId: number;
    readonly portainerUrl: string;
  }[],
): UsageError {
  return new UsageError(
    `container '${name}' ambiguous — ${candidates.length} Portainer endpoints:`,
    {
      details: candidates
        .map((row) =>
          `  endpoint=${row.endpointName}  id=${row.endpointId}` +
          `  url=${row.portainerUrl}`
        )
        .join("\n"),
    },
  );
}
