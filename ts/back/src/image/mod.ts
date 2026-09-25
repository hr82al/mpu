/**
 * Образ (`docs/specs/platform/image.md`): методы пользователя, записанные
 * в `image.db`, — строки, сохранённые методом получателя.
 */

export { Image, ImageError } from "./image.ts";
export { MethodAddress, Misaddressed, type Named } from "./address.ts";
export {
  imageSyncCommand,
  SYNC_PATH,
  type SyncArgs,
  syncArgsSchema,
} from "./cmd_sync.ts";
export {
  EXPORT_PATH,
  type ExportArgs,
  exportArgsSchema,
  imageExportCommand,
} from "./cmd_export.ts";
export {
  type Applier,
  conflictEntry,
  type Done,
  type Entry,
  Failed,
  type Overflow,
  Plan,
  type Preference,
  SUCCEEDED,
  Unparsed,
  WAITING,
  waitingEntry,
} from "./plan.ts";
export {
  BaseMethod,
  type FilesRead,
  keyOf,
  type MethodFile,
  readFiles,
  type Receivers,
  UnreadableDir,
} from "./sides.ts";
export {
  blockParams,
  canonicalLine,
  DEFINE,
  isPlain,
  KEYS,
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
