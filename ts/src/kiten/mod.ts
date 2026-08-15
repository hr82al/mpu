/**
 * Публичная поверхность команд семейства `mpu kiten` — тонких команд над
 * каталогами внешнего API Kaiten (`../kaiten/`). Перенесены: `mpu kiten
 * card` (`docs/specs/kiten-card.md`), `mpu kiten field`
 * (`docs/specs/kiten-field.md`) и `mpu kiten comment`
 * (`docs/specs/kiten-comment.md`).
 *
 * Наружу отдаются объявления команд — их берёт реестр; аргументы,
 * результаты и шаги вызова остаются внутри своих файлов.
 */

export {
  type CardOutputView,
  type KitenCardArgs,
  kitenCardCommand,
  type KitenCardResult,
  runKitenCard,
} from "./cmd_card.ts";

export {
  kitenArtefactRmCommand,
  kitenArtefactSetCommand,
  kitenFieldSetCommand,
} from "./cmd_field.ts";

export { kitenCommentCommand } from "./cmd_comment.ts";
