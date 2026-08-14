/**
 * Публичная поверхность платформенного атома Kaiten
 * (`docs/specs/platform/kaiten-http.md`): транспорт (доступ, форма
 * запроса, retry на 429, пагинация, формат ошибки) и селектор карточки —
 * `./http.ts` и `./card_ref.ts`; каталог учёта времени и таймеров
 * (`platform/kaiten-api-time.md`) — `./time.ts`; каталог карточки и её
 * содержимого (`platform/kaiten-api-cards.md`) — `./cards.ts`; прогрев
 * справочников с записью в кэш-БД — `./warmup.ts`.
 *
 * Потребители — команда `init` (шаг 4) и, по мере переноса, подкоманды
 * `mpu kiten`.
 */

export {
  type KaitenAccess,
  type KaitenCallOptions,
  KaitenError,
  type KaitenMethod,
  type KaitenRequest,
  requireKaitenAccess,
  retryDelayMs,
} from "./http.ts";

export { parseCardRef } from "./card_ref.ts";

export {
  type Card,
  type CardCondition,
  type CardFile,
  type CardFilter,
  type CardLocation,
  type CardProperties,
  type CardState,
  type CardSummary,
  type CardTimer,
  type Checklist,
  type ChecklistItem,
  type ChecklistItemPatch,
  type Comment,
  createCardChecklist,
  createCardComment,
  createCardCommentWithFiles,
  createChecklistItem,
  deleteCardFile,
  getCard,
  listCardComments,
  listCardLocationHistory,
  listCards,
  type LocationChange,
  type Member,
  moveCard,
  type NewChecklistItem,
  updateCardDescription,
  updateCardProperties,
  updateChecklistItem,
  uploadCustomPropertyFile,
  type UploadFile,
} from "./cards.ts";

export {
  createCardTimeLog,
  deleteCardTimeLog,
  type KaitenRole,
  listCardTimeLogs,
  listUserRoles,
  listUserTimeLogs,
  resetUserTimer,
  startUserTimer,
  stopUserTimer,
  type TimeLog,
  type TimeLogCard,
  type TimeLogEntry,
  type TimeLogPatch,
  type TimeLogWindow,
  type Timer,
  type TimerStartOutcome,
  type TimerStartRequest,
  type TimerStopRequest,
  updateCardTimeLog,
  type UserTimeLog,
} from "./time.ts";

export {
  collectKaitenWarmup,
  DEFAULT_KAITEN_LIMITS,
  type KaitenLimits,
  type KaitenWarmup,
  WARMUP_BUDGET_MS,
  writeKaitenWarmup,
} from "./warmup.ts";
