/**
 * Образ (`docs/specs/platform/image.md`): методы пользователя, записанные
 * в `image.db`, — строки, сохранённые методом получателя.
 */

export { Image, ImageError } from "./image.ts";
export {
  DEFINE,
  isPlain,
  PURPOSE,
  type Said,
  saidOf,
  storedName,
} from "./definition.ts";
export {
  ImageMethod,
  type MethodRecord,
  type MethodSnapshot,
} from "./method.ts";

/**
 * Файл образа в каталоге состояния, рядом с `policy.db`.
 *
 * @param stateDir каталог состояния; `undefined` — нет HOME
 */
export function imageFile(stateDir: string | undefined): string | undefined {
  return stateDir === undefined ? undefined : `${stateDir}/image.db`;
}
