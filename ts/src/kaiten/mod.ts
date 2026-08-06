/**
 * Публичная поверхность платформенного атома Kaiten
 * (`docs/specs/platform/kaiten-http.md`): транспорт (доступ, форма
 * запроса, retry на 429, формат ошибки) — `./http.ts`; прогрев
 * справочников с записью в кэш-БД — `./warmup.ts`.
 *
 * Потребители — команда `init` (шаг 4) и, по мере переноса, подкоманды
 * `mpu kiten`.
 */

export {
  type KaitenAccess,
  KaitenError,
  requireKaitenAccess,
  retryDelayMs,
} from "./http.ts";

export {
  collectKaitenWarmup,
  DEFAULT_KAITEN_LIMITS,
  type KaitenLimits,
  type KaitenWarmup,
  WARMUP_BUDGET_MS,
  writeKaitenWarmup,
} from "./warmup.ts";
