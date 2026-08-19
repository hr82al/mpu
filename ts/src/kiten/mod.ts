/**
 * Публичная поверхность команд семейства `mpu kiten` — тонких команд над
 * каталогами внешнего API Kaiten (`../kaiten/`). Перенесены: `mpu kiten
 * card` (`docs/specs/kiten-card.md`), `mpu kiten field`
 * (`docs/specs/kiten-field.md`), `mpu kiten comment`
 * (`docs/specs/kiten-comment.md`), учёт времени `mpu kiten time`
 * (`docs/specs/kiten-time.md`) — записи и личный таймер — и чек-листы
 * `mpu kiten checklist` (`docs/specs/kiten-checklist.md`) и
 * оркестратор закрытия `mpu kiten close` (`docs/specs/kiten-close.md`),
 * список карточек `mpu kiten ls` (`docs/specs/kiten-ls.md`) и
 * справочники `mpu kiten whoami`/`spaces`/`boards`/`lanes`/
 * `columns`/`roles` (`docs/specs/kiten-refs.md`).
 *
 * Наружу отдаются объявления команд — их берёт реестр; аргументы,
 * результаты и шаги вызова остаются внутри своих файлов.
 */

export {
  type KitenCardArgs,
  kitenCardCommand,
  type KitenCardResult,
  runKitenCard,
} from "./cmd_card.ts";

export { kitenCloseCommand } from "./cmd_close.ts";

export {
  kitenMoveCommand,
  kitenReadyCommand,
  kitenReviewCommand,
} from "./cmd_move.ts";

export {
  kitenChecklistAddCommand,
  kitenChecklistCheckCommand,
  kitenChecklistLsCommand,
  kitenChecklistUncheckCommand,
} from "./cmd_checklist.ts";

export {
  kitenArtefactRmCommand,
  kitenArtefactSetCommand,
  kitenFieldSetCommand,
} from "./cmd_field.ts";

export { kitenCommentCommand } from "./cmd_comment.ts";

export {
  type KitenLsArgs,
  kitenLsCommand,
  type KitenLsResult,
  runKitenLs,
} from "./cmd_ls.ts";

export {
  kitenBoardsCommand,
  kitenColumnsCommand,
  kitenLanesCommand,
  kitenRolesCommand,
  kitenSpacesCommand,
  kitenWhoamiCommand,
} from "./cmd_refs.ts";

export {
  kitenTimeAddCommand,
  kitenTimeEditCommand,
  kitenTimeLsCommand,
  kitenTimeRmCommand,
} from "./cmd_time.ts";

export {
  kitenTimeDiscardCommand,
  kitenTimeStartCommand,
  kitenTimeStatusCommand,
  kitenTimeStopCommand,
} from "./cmd_timer.ts";
export {
  type KitenStatusArgs,
  kitenStatusCommand,
  type KitenStatusResult,
  renderStatus,
  runKitenStatus,
  type StatusOptions,
} from "./cmd_status.ts";
