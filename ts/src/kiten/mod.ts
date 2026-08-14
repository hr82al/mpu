/**
 * Публичная поверхность команд семейства `mpu kiten` — тонких команд над
 * каталогами внешнего API Kaiten (`../kaiten/`). Пока перенесена одна:
 * `mpu kiten card` (`docs/specs/kiten-card.md`).
 */

export {
  type CardOutputView,
  type KitenCardArgs,
  kitenCardCommand,
  type KitenCardResult,
  runKitenCard,
} from "./cmd_card.ts";
