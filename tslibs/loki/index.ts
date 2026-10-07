/**
 * `@mpu/loki` — разговор с Loki без привязки к рантайму и к слою команд
 * (`ts/docs/specs/platform/tslibs-ops.md`): series-запрос за окно discovery
 * в уникальные хосты и пары (host, service) (`platform/loki-http.md`) и
 * чтение записей `query_range` (`logs.md`).
 *
 * Адрес — параметром `LokiAccess` (из env-файла — `requireLokiAccess`);
 * записи в кэш-БД здесь нет — её делает потребитель. Описание каждого
 * имени — JSDoc у его определения.
 */

export {
  collectLokiSeries,
  type LogEntry,
  type LokiAccess,
  LokiError,
  LokiHttpError,
  type LokiSeries,
  queryRange,
  type RangeQuery,
  requireLokiAccess,
} from "./src/loki.ts";
