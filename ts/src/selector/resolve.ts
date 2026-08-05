/**
 * Резолв селектора (`docs/specs/platform/selector.md`): строка адресации
 * (`sl-N`, client_id, email, IP, spreadsheet_id, sid, заголовок) → номер
 * сервера и кандидаты; вторая ступень — сужение до единственного клиента.
 *
 * Логика одна на все native-команды: трактовать селектор самостоятельно
 * командам запрещено (спека, «Инварианты»). Командные расширения
 * (`dev:`, sw-алиасы, точное имя контейнера) перехватываются ДО этого
 * резолва и живут в своих командах.
 */

import { type Candidate, serverNumberOf } from "./candidate.ts";
import {
  assertInitialized,
  type CacheReader,
  clientCandidates,
  clientIdsOfEmail,
  clientIdsOfSid,
  spreadsheetCandidates,
} from "./cache.ts";
import { SelectorError } from "./error.ts";

/** Маска email — та же, по которой команда поиска выбирает email-ветку. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Целое, включая отрицательное: отдельной валидации диапазона нет. */
const CLIENT_ID = /^-?\d+$/;

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Ключи адресов серверов в env-файле; `sl_<N>_portainer` — не адрес. */
const ADDRESS_KEY = /^(?:sl|pg)_(\d+)$/;

/** Адреса серверов стенда (`platform/env-file.md`) глазами резолва. */
export interface ServerAddresses {
  /** Все пары «ключ → значение»: номер сервера ищется по значению. */
  readonly values: () => Readonly<Record<string, string>>;
}

/** Откуда резолв читает: локальный кэш и env-файл. Сети нет. */
export interface SelectorSources {
  readonly cache: CacheReader;
  readonly env: ServerAddresses;
}

/** Override сервера: значение флага `--server`, если он задан. */
export interface ResolveOptions {
  readonly server?: string;
}

/** Успешный резолв: сервер один, кандидаты — всё, что совпало. */
export interface Resolved {
  /** Исходный селектор: его называют тексты второй ступени. */
  readonly selector: string;
  readonly serverNumber: number;
  readonly candidates: readonly Candidate[];
}

type Predicate = (
  sources: SelectorSources,
  value: string,
) => readonly Candidate[];

/**
 * Порядок предикатов однопроходного поиска (спека, «Ввод/вывод», п. 3):
 * побеждает первый непустой. Порядок объявлен здесь и больше нигде — в
 * нём вся семантика «sid раньше spreadsheet_id, заголовок последним».
 */
const PREDICATES: readonly Predicate[] = [
  byEmail,
  byClientId,
  byServerAddress,
  bySid,
  bySpreadsheetId,
  byTitle,
];

/**
 * Разбирает селектор в номер сервера и кандидатов. Отказ — `SelectorError`
 * (exit 2) с приложенными кандидатами; состояния не меняет.
 */
export function resolveSelector(
  sources: SelectorSources,
  selector: string,
  options: ResolveOptions = {},
): Resolved {
  if (options.server !== undefined) {
    const overridden = serverNumberOf(options.server);
    if (overridden === null) {
      throw new SelectorError(
        `bad --server: '${options.server}' (expected sl-N)`,
      );
    }
    // Override замещает value целиком: кэш не читается, кандидатов нет.
    return { selector, serverNumber: overridden, candidates: [] };
  }
  const short = serverNumberOf(selector);
  if (short !== null) return { selector, serverNumber: short, candidates: [] };

  const checked = { cache: checkedCache(sources.cache), env: sources.env };
  return verdict(selector, search(checked, selector));
}

/**
 * Вторая ступень: единственный client_id кандидатов — командам, которые
 * адресуют клиента, а не сервер. Все три отказа — те же `SelectorError`.
 */
export function requireSingleClient(resolved: Resolved): number {
  const { selector, serverNumber, candidates } = resolved;
  if (candidates.length === 0) {
    throw new SelectorError(
      `selector '${selector}' resolved to sl-${serverNumber} but does not ` +
        "point to a specific client; pass client_id / spreadsheet / title",
    );
  }
  const clientIds = [
    ...new Set(
      candidates
        .map((candidate) => candidate.clientId)
        .filter((clientId) => clientId !== null),
    ),
  ];
  if (clientIds.length === 0) {
    throw new SelectorError(
      "selector resolved to a server but no client_id; use a selector " +
        "that points to a specific client",
      { candidates },
    );
  }
  if (clientIds.length > 1) {
    throw new SelectorError(
      `selector matches ${clientIds.length} clients — narrow it down`,
      { candidates },
    );
  }
  return clientIds[0];
}

function search(
  sources: SelectorSources,
  value: string,
): readonly Candidate[] {
  for (const predicate of PREDICATES) {
    const found = predicate(sources, value);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Вердикт по множеству различных номеров серверов среди кандидатов
 * (спека, «Ввод/вывод», п. 4): однозначность считается по серверам, а не
 * по числу кандидатов, и кандидаты без сервера в множестве не участвуют.
 */
function verdict(selector: string, candidates: readonly Candidate[]): Resolved {
  if (candidates.length === 0) {
    throw new SelectorError(
      EMAIL.test(selector)
        ? `email '${selector}' не в кэше; сначала запусти: mpu search ${selector}`
        : `nothing matched: '${selector}'`,
    );
  }
  const servers = new Set(
    candidates
      .map((candidate) => candidate.serverNumber)
      .filter((serverNumber) => serverNumber !== null),
  );
  if (servers.size === 0) {
    throw new SelectorError(
      `matched but no server resolvable: '${selector}'`,
      { candidates },
    );
  }
  if (servers.size > 1) {
    throw new SelectorError(
      `ambiguous selector '${selector}' — ${candidates.length} ` +
        "candidates on different servers",
      { candidates },
    );
  }
  return { selector, serverNumber: [...servers][0], candidates };
}

/**
 * Кэш, который перед первым же запросом проверяет, что схема на месте.
 * Проверка ленивая: путям, которым кэш не нужен (`sl-N`, override, IP из
 * env-файла), непроинициализированная БД не мешает.
 */
function checkedCache(cache: CacheReader): CacheReader {
  let initialized = false;
  return {
    query: (sql, ...params) => {
      if (!initialized) {
        assertInitialized(cache);
        initialized = true;
      }
      return cache.query(sql, ...params);
    },
  };
}

function byEmail(
  sources: SelectorSources,
  value: string,
): readonly Candidate[] {
  if (!EMAIL.test(value)) return [];
  // Только из кэша: сетевой резолв email резолв не запускает никогда
  // (спека, «Инварианты»). Ключ кэша — email в нижнем регистре.
  return clientCandidates(
    sources.cache,
    clientIdsOfEmail(sources.cache, value.toLowerCase()),
  );
}

function byClientId(
  sources: SelectorSources,
  value: string,
): readonly Candidate[] {
  if (!CLIENT_ID.test(value)) return [];
  return clientCandidates(sources.cache, [Number(value)]);
}

/**
 * IP ищется в конфиге серверов, а не в кэш-БД. Один адрес у ключей разных
 * серверов — битый конфиг: спека требует назвать конфликтующие ключи, а не
 * прятать их за generic `nothing matched` (fix-отклонение).
 */
function byServerAddress(
  sources: SelectorSources,
  value: string,
): readonly Candidate[] {
  if (!IPV4.test(value)) return [];
  const keys: string[] = [];
  const numbers = new Set<number>();
  for (const [key, address] of Object.entries(sources.env.values())) {
    const matched = ADDRESS_KEY.exec(key);
    if (matched === null || address !== value) continue;
    keys.push(key);
    numbers.add(Number(matched[1]));
  }
  if (numbers.size > 1) {
    throw new SelectorError(
      `конфликт адресов в env-файле: '${value}' задан ключами ` +
        keys.sort().join(", "),
    );
  }
  if (numbers.size === 0) return [];
  const serverNumber = [...numbers][0];
  return [{
    clientId: null,
    spreadsheetId: null,
    title: null,
    server: `sl-${serverNumber}`,
    serverNumber,
    sids: [],
  }];
}

function bySid(sources: SelectorSources, value: string): readonly Candidate[] {
  return clientCandidates(
    sources.cache,
    clientIdsOfSid(sources.cache, value),
  );
}

function bySpreadsheetId(
  sources: SelectorSources,
  value: string,
): readonly Candidate[] {
  return spreadsheetCandidates(sources.cache, "ss_id", value);
}

function byTitle(
  sources: SelectorSources,
  value: string,
): readonly Candidate[] {
  return spreadsheetCandidates(sources.cache, "title", value);
}
