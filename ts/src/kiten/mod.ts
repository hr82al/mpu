/**
 * Публичная поверхность команд семейства `mpu kiten` — тонких команд над
 * каталогами внешнего API Kaiten (`../kaiten/`). Пока перенесена одна:
 * `mpu kiten card` (`docs/specs/kiten-card.md`) и `mpu kiten field`
 * (`docs/specs/kiten-field.md`).
 */

export {
  type CardOutputView,
  type KitenCardArgs,
  kitenCardCommand,
  type KitenCardResult,
  runKitenCard,
} from "./cmd_card.ts";

export {
  type FieldKind,
  type KitenArtefactRmArgs,
  kitenArtefactRmCommand,
  type KitenArtefactRmResult,
  type KitenArtefactSetArgs,
  kitenArtefactSetCommand,
  type KitenArtefactSetResult,
  type KitenFieldSetArgs,
  kitenFieldSetCommand,
  type KitenFieldSetResult,
  runKitenArtefactRm,
  runKitenArtefactSet,
  runKitenFieldSet,
} from "./cmd_field.ts";
