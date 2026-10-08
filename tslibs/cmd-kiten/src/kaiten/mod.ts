/**
 * Прогрев справочников Kaiten с записью в кэш-БД команд
 * (`docs/specs/platform/kaiten-http.md`, «Прогрев справочников»;
 * `docs/specs/init.md`, шаг 4) — `./warmup.ts`. Разговор с Kaiten
 * (транспорт, селектор карточки, каталоги) — библиотека `@mpu/kaiten`
 * (`docs/specs/platform/tslibs-kaiten.md`); здесь — состав прогрева, бюджет
 * шага и запись собранного в кэш-БД команд.
 *
 * Потребители — команда `init` (шаг 4), `mpu kiten refs` и `mpu kiten
 * status` (запись справочников в кэш).
 */

export {
  collectKaitenWarmup,
  DEFAULT_KAITEN_LIMITS,
  type KaitenLimits,
  type KaitenWarmup,
  WARMUP_BUDGET_MS,
  writeBoardRows,
  writeKaitenWarmup,
} from "./warmup.ts";
