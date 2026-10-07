/**
 * Ошибки ОС по их коду. Код — общий язык `node:fs`, подпроцессов и
 * файловых вызовов Deno: у ошибок всех трёх одно поле `code` с одними
 * значениями (`ENOENT`, `EACCES`, …), поэтому различение по нему не
 * зависит от того, каким API вызвана операция.
 */

/** Коды ошибок ОС, которые различает код `back/`. */
export type OsErrorCode =
  | "ENOENT"
  | "ENOTDIR"
  | "EISDIR"
  | "EACCES"
  | "EPERM"
  | "EEXIST"
  | "EPIPE";

/** Ошибка ОС с одним из кодов `codes`. */
export function hasErrorCode(
  err: unknown,
  ...codes: readonly OsErrorCode[]
): boolean {
  if (!(err instanceof Error) || !("code" in err)) return false;
  return codes.some((code) => err.code === code);
}

/** Ошибка ОС с кодом `code` — для подменных файлов и процессов в тестах. */
export function osError(code: OsErrorCode, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Отказ права процесса Deno (`--allow-*`). У него нет кода ОС — только
 * имя, и под `node:fs` тоже (проба порции E2). Права уходят вместе со
 * сборкой `deno compile` (`platform/node-runtime.md`, E4).
 */
export function isPermissionRefusal(err: unknown): boolean {
  return err instanceof Error && err.name === "NotCapable";
}
