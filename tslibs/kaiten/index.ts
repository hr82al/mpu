/**
 * `@mpu/kaiten` — разговор с API Kaiten без привязки к рантайму и к слою
 * команд (`ts/docs/specs/platform/tslibs-kaiten.md`): транспорт (доступ,
 * форма запроса, повтор на 429, пагинация, формат ошибки —
 * `platform/kaiten-http.md`), селектор карточки и каталоги карточек
 * (`kaiten-api-cards.md`), учёта времени (`kaiten-api-time.md`) и
 * справочников (`kaiten-api-refs.md`).
 *
 * Токен и адрес — параметром `KaitenAccess`; кэша и текстов команд здесь
 * нет. Фейковый Kaiten для тестов — `@mpu/kaiten/testing`. Описание
 * каждого имени — JSDoc у его определения.
 */

export {
  KAITEN_TIMEOUTS,
  type KaitenAccess,
  kaitenBaseUrl,
  type KaitenCallOptions,
  KaitenError,
  type KaitenMethod,
  type KaitenRequest,
  requireKaitenAccess,
  retryDelayMs,
} from "./src/http.ts";

export { KaitenInputError, parseCardRef } from "./src/card_ref.ts";

export {
  type Card,
  type CardCondition,
  type CardFile,
  type CardFilter,
  type CardLocation,
  type CardProperties,
  type CardState,
  type CardSummary,
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
} from "./src/cards.ts";

export {
  type Activity,
  type ActivityFeedRequest,
  type Board,
  type Column,
  type CurrentUser,
  type CustomProperty,
  getCurrentUser,
  type Lane,
  listBoardColumns,
  listBoardLanes,
  listCustomProperties,
  listSpaces,
  listUserActivities,
  type Space,
} from "./src/refs.ts";

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
} from "./src/time.ts";
