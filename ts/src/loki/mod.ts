/**
 * HTTP-клиент Loki (`docs/specs/platform/loki-http.md`): один GET
 * series-запрос за discovery-окно, разбор ответа в уникальные хосты и
 * пары (host, service), полная перезапись итога в кэш-БД, а также
 * чтение записей эндпоинтом `query_range` (`docs/specs/logs.md`).
 * Модуль не знает ни о команде `init`, ни о команде `logs` — только о
 * протоколе Loki и о таблицах кэша `loki_hosts`/`loki_services_by_host`
 * (`platform/store.md`), в которые пишет.
 *
 * Транспорт — общий `httpGet` (`../http/mod.ts`): пределы времени одного
 * вызова и причина отказа одной строкой там уже решены, здесь — только
 * трактовка протокола Loki.
 *
 * Модуль вынесен из `src/init/`: это платформенный атом
 * (`docs/specs/platform/loki-http.md`), а не часть команды init, и с
 * появлением второго потребителя (`update`) импорт мимо `mod.ts`
 * нарушил бы границу модулей.
 */

import {
  DEFAULT_TIMEOUTS,
  httpGet,
  type HttpResponse,
  type RequestTimeouts,
} from "../http/mod.ts";
import type { CacheDb } from "../command/mod.ts";

/** Путь series API относительно `baseUrl`. */
const SERIES_PATH = "/loki/api/v1/series";
/** Матчер «все хосты» — константа оригинала (открытые вопросы спеки). */
const MATCH_ALL_HOSTS = '{host=~".+"}';
/** Окно discovery — «последние 24 часа» (спека, раздел «Ввод/вывод»). */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Подключение к Loki: базовый URL без хвостовых `/`. */
export interface LokiAccess {
  readonly baseUrl: string;
}

/** Пара «хост — сервис» из лейблов series. */
export interface HostService {
  readonly host: string;
  readonly service: string;
}

/** Итог discovery: уникальные хосты и уникальные пары. */
export interface LokiSeries {
  readonly hosts: readonly string[];
  readonly pairs: readonly HostService[];
}

/**
 * Сбой прогрева Loki; сообщение — «<причина>» одной строкой, без
 * префикса «loki:» (его добавляет потребитель, `init.md`, шаг 3).
 */
export class LokiError extends Error {
  override name = "LokiError";
}

/** Пустой итог discovery — переиспользуется всеми ветками `parseSeries`. */
const EMPTY_SERIES: LokiSeries = { hosts: [], pairs: [] };

/**
 * Базовый URL из env-файла; ключа нет или он пуст — `LokiError`
 * («LOKI_URL не задан»). Хвостовые `/` срезаются той же нормализацией,
 * что у `requirePortainerAccess` (`cmd_init.ts`) — оба клиента строят
 * путь конкатенацией `baseUrl + path`, и лишний `/` сложил бы двойной
 * слэш в адресе.
 */
export function requireLokiAccess(
  envFile: { readonly get: (name: string) => string | undefined },
): LokiAccess {
  const rawUrl = envFile.get("LOKI_URL");
  if (rawUrl === undefined || rawUrl === "") {
    throw new LokiError("LOKI_URL не задан");
  }
  return { baseUrl: rawUrl.replace(/\/+$/, "") };
}

/**
 * Один GET series за окно 24 часа; `nowMs` — момент прогона (граница
 * окна), по умолчанию текущее время. Не-2xx → `LokiError("HTTP <код>")`;
 * сетевой сбой или срабатывание одного из двух пределов `timeouts` →
 * `LokiError` с причиной `httpGet` (уже одной строкой) и исходной
 * ошибкой в `cause`. Ответ неожиданной формы (без `data`, `data` не
 * список, тело не JSON) — не ошибка, а пустой результат: наблюдаемое
 * поведение оригинала (`loki-http.md`, «Граничные случаи и ошибки»).
 */
export async function collectLokiSeries(
  access: LokiAccess,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
  nowMs: number = Date.now(),
): Promise<LokiSeries> {
  const url = new URL(`${access.baseUrl}${SERIES_PATH}`);
  url.searchParams.set("match[]", MATCH_ALL_HOSTS);
  url.searchParams.set("start", toNanoseconds(nowMs - WINDOW_MS));
  url.searchParams.set("end", toNanoseconds(nowMs));

  let response: HttpResponse;
  try {
    response = await httpGet(url, { timeouts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LokiError(message, { cause: err });
  }

  if (response.status < 200 || response.status >= 300) {
    throw new LokiError(`HTTP ${response.status}`);
  }
  return parseSeries(response.text);
}

/**
 * Момент в миллисекундах → строка unix-наносекунд для параметров
 * `start`/`end`. Через конкатенацию строк, а не арифметику: итоговое
 * значение (около 1.7e18 для текущих дат) вылезает за
 * `Number.MAX_SAFE_INTEGER` (~9e15), и любое промежуточное вычисление в
 * `Number` (например, перевод в секунды делением с последующим
 * умножением на 1e9) теряет младшие разряды — Loki получит не ту
 * границу окна, при этом без всякого намёка на ошибку в виде
 * экспоненциальной записи — та проявляется лишь при значении,
 * составленном из даты далеко за пределами диапазона, который вообще
 * умеет представлять `Date` (`ms` порядка 1e15 и больше). `Math.trunc`
 * — на случай нецелого `nowMs` от вызывающего: `Date.now()`
 * целый всегда, но контракт параметра — просто `number`.
 */
function toNanoseconds(ms: number): string {
  return `${Math.trunc(ms)}000000`;
}

/**
 * Разбор тела ответа series API. Ответ без `data`, с `data` не-списком
 * или телом не-JSON даёт пустой результат (см. `collectLokiSeries`).
 *
 * Отдельная запись учитывается только при строковом непустом лейбле
 * `host` (`platform/loki-http.md`: «host — строка, обязателен для
 * учёта»); всё прочее — не-объект, отсутствующий или нестроковый
 * `host` — пропускается поштучно, остальные записи разбираются. Иначе
 * один мусорный элемент обнулял бы весь прогрев, а спека называет
 * пустым результатом ответ неожиданной ФОРМЫ, а не список с одной
 * негодной записью.
 */
function parseSeries(text: string): LokiSeries {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_SERIES;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) return EMPTY_SERIES;

  const hosts: string[] = [];
  const hostSeen = new Set<string>();
  const pairs: HostService[] = [];
  const pairSeen = new Set<string>();

  for (const entry of parsed.data) {
    if (!isRecord(entry)) continue;

    const host = entry.host;
    if (typeof host !== "string" || host === "") continue;
    if (!hostSeen.has(host)) {
      hostSeen.add(host);
      hosts.push(host);
    }

    const service = entry.compose_service;
    if (typeof service !== "string") continue;
    // Разделитель `\0` — символ, которого не бывает в лейблах Loki, поэтому
    // конкатенация host+service не может случайно схлопнуть разные пары.
    const pairKey = `${host}\0${service}`;
    if (!pairSeen.has(pairKey)) {
      pairSeen.add(pairKey);
      pairs.push({ host, service });
    }
  }
  return { hosts, pairs };
}

/** Путь чтения записей относительно `baseUrl`. */
const QUERY_RANGE_PATH = "/loki/api/v1/query_range";

/** Одна запись потока: время в наносекундах и текст строки как есть. */
export interface LogEntry {
  /** Целое число наносекунд unix-времени, строкой (в `number` не влезает). */
  readonly tsNs: string;
  readonly line: string;
}

/** Что спрашивают у `query_range`: окно, предел и конец окна-источник. */
export interface RangeQuery {
  readonly logql: string;
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly limit: number;
  /** Какой конец окна отдаёт источник, когда записей больше предела. */
  readonly direction: "backward" | "forward";
}

/**
 * Ответ Loki вне 2xx. Код и тело — отдельными полями: потребитель
 * собирает из них свой текст (`logs.md`: `loki HTTP <код>: <тело>`), а
 * различает отказы по типу, а не по сообщению.
 */
export class LokiHttpError extends LokiError {
  override name = "LokiHttpError";
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Записи окна одним запросом. Не-2xx → `LokiHttpError`; сетевой сбой и
 * срабатывание предела времени → `LokiError` с причиной от `httpGet`.
 * Мусор в теле ответа записями не считается, но и ошибкой не является
 * (`logs.md`, «Побочные эффекты»): негодная пара пропускается поштучно.
 */
export async function queryRange(
  access: LokiAccess,
  query: RangeQuery,
  timeouts: RequestTimeouts = DEFAULT_TIMEOUTS,
): Promise<readonly LogEntry[]> {
  const url = new URL(`${access.baseUrl}${QUERY_RANGE_PATH}`);
  url.searchParams.set("query", query.logql);
  url.searchParams.set("start", query.startNs.toString());
  url.searchParams.set("end", query.endNs.toString());
  url.searchParams.set("limit", String(query.limit));
  url.searchParams.set("direction", query.direction);

  let response: HttpResponse;
  try {
    response = await httpGet(url, { timeouts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LokiError(message, { cause: err });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new LokiHttpError(response.status, response.text);
  }
  return parseEntries(response.text);
}

/**
 * Разбор ответа `query_range`. Терпимость к мусору задана спекой
 * команды: верхний уровень не по схеме → 0 записей; элемент `result` не
 * по схеме → пропуск только его; негодная пара `values` (не массив,
 * короче двух, нестроковая, нецелый ts) → пропуск пары. Элементы пары
 * после второго игнорируются.
 */
function parseEntries(text: string): readonly LogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) return [];
  const result = parsed.data.result;
  if (!Array.isArray(result)) return [];

  const entries: LogEntry[] = [];
  for (const stream of result) {
    if (!isRecord(stream) || !Array.isArray(stream.values)) continue;
    for (const pair of stream.values) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const [tsNs, line] = pair;
      if (typeof tsNs !== "string" || typeof line !== "string") continue;
      if (!/^\d+$/.test(tsNs)) continue;
      entries.push({ tsNs, line });
    }
  }
  return entries;
}

/** Значение — объект лейблов (не массив, не `null`, не примитив). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Полная перезапись обеих таблиц (`loki_hosts`, `loki_services_by_host`)
 * одной транзакцией; `discoveredAt` — unix-секунды. DELETE и вставки —
 * внутри одного `db.transaction`, поэтому сбой посреди записи откатывает
 * всё целиком: инвариант спеки «обе таблицы либо перезаписаны целиком,
 * либо не тронуты» (`loki-http.md`, «Инварианты») не допускает половинки
 * в виде пустых таблиц после упавшей вставки.
 */
export function writeLokiCache(
  db: CacheDb,
  series: LokiSeries,
  discoveredAt: number,
): void {
  db.transaction(() => {
    db.execute("DELETE FROM loki_hosts");
    for (const host of series.hosts) {
      db.execute(
        "INSERT INTO loki_hosts (host, discovered_at) VALUES (?, ?)",
        host,
        discoveredAt,
      );
    }
    db.execute("DELETE FROM loki_services_by_host");
    for (const pair of series.pairs) {
      db.execute(
        "INSERT INTO loki_services_by_host (host, service, discovered_at) VALUES (?, ?, ?)",
        pair.host,
        pair.service,
        discoveredAt,
      );
    }
  });
}
