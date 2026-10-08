/**
 * Поверхность пакета: образ (`platform/image.md`) — методы пользователя,
 * записанные в `image.db`, — и команды `mpu image sync`
 * (`image-sync.md`), `mpu image export` (`image-export.md`). Отдаётся то,
 * что берут реестр, ядро строк и сервер приложения; прочее — внутренности.
 */

export { Image, ImageError, imageFile } from "./src/image.ts";
export { MethodAddress, Misaddressed } from "./src/address.ts";
export {
  imageSyncCommand,
  SYNC_PATH,
  syncArgsSchema,
} from "./src/cmd_sync.ts";
export {
  EXPORT_PATH,
  exportArgsSchema,
  imageExportCommand,
} from "./src/cmd_export.ts";
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
} from "./src/plan.ts";
export {
  BaseMethod,
  type FilesRead,
  keyOf,
  lineHash,
  type MethodFile,
  readFiles,
  type Receivers,
  UnreadableDir,
} from "./src/sides.ts";
export {
  DEFINE,
  isPlain,
  PURPOSE,
  saidOf,
  storedName,
} from "./src/definition.ts";
export { ImageMethod, type MethodSnapshot } from "./src/method.ts";
